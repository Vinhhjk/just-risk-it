import { ethers } from "ethers";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import dotenv from 'dotenv';
import { WebSocketServer, WebSocket } from 'ws';
import { generateServerSeed, computeServerSeedHash, generateCrashGame } from './crash-game-backend.js';
import { requestAndWaitForEntropy } from './pyth-entropy-handler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const NETWORKS = {
  'monad-testnet': {
    chainId: 10143,
    rpcUrl: 'https://testnet-rpc.monad.xyz',
    entropy: '0x825c0390f379c631f3cf11a82a37d20bddf93c07', // Pyth Entropy on Monad testnet
    blockExplorer: 'https://testnet.monadexplorer.com',
    revealDelayBlocks: 2, // Reveal delay is 2 blocks
  },
  'monad-mainnet': {
    chainId: 143,
    rpcUrl: 'https://rpc.monad.xyz',
    entropy: '0x0000000000000000000000000000000000000000', // TODO: Get mainnet address
    blockExplorer: 'https://monadexplorer.com',
    revealDelayBlocks: 2,
  },
};

const PYTH_ENTROPY_ABI = [
  'function getFeeV2() external view returns (uint256)',
  'function requestV2() external payable returns (uint64)',
];

const CRASH_GAME_ABI = [
  'function createRound(bytes32 serverSeedHash) external returns (uint256)',
  'function requestRandomness(uint256 roundId) external payable',
  'function revealServerSeed(uint256 roundId, bytes calldata serverSeed) external',
  'function getRound(uint256 roundId) external view returns (bytes32 serverSeedHash, bytes serverSeed, uint64 sequenceNumber, uint256 entropyRandom, uint8 status)',
  'function isRandomReady(uint256 roundId) external view returns (bool)',
  'function roundCounter() external view returns (uint256)',
  'function settleRound(uint256 roundId, uint256 finalMultiplier, bytes calldata serverSeed) external',
  'function processCashOuts(uint256 roundId, tuple(address wallet, uint256 multiplier)[] cashOuts) external',
  'function getBet(uint256 roundId, address user) external view returns (uint256 amount, uint256 cashOutMultiplier, bool settled)',
  'function token() external view returns (address)',
];

const TOKEN_ABI = [
  'function balanceOf(address account) external view returns (uint256)',
];

// Constants matching the contract
const MAX_BET = 1000; // 1000 tokens
const MAX_WIN_PERCENTAGE = 0.70; // 70% of contract balance
const HOUSE_EDGE = 0.015; // 1.5%

// Cash-out tracking
interface CashOut {
  walletAddress: string;
  multiplier: number;
  timestamp: number;
  verified: boolean;
}

// Active round tracking
interface ActiveRound {
  roundId: bigint;
  currentMultiplier: number;
  state: 'betting' | 'running' | 'ended';
  finalMultiplier?: number;
}

const activeCashOuts = new Map<number, CashOut[]>(); // roundId -> cash-outs
const activeRounds = new Map<number, ActiveRound>(); // roundId -> round info

// Chat message tracking
interface ChatMessage {
  id: string;
  user: string; // Formatted address (first 4 + ... + last 4)
  address: string; // Full address
  message: string;
  timestamp: number;
}

const chatMessages: ChatMessage[] = []; // Store last 4 messages
const MAX_CHAT_MESSAGES = 4;

// Helper function to format address
function formatAddress(address: string): string {
  if (!address || address.length < 8) return address;
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

// Global current game state (for new client connections)
interface CurrentGameState {
  roundId: number | null;
  gameState: 'preparing' | 'betting' | 'prepared' | 'running' | 'ended';
  currentMultiplier: number;
  bettingCloseTime: number | null;
  latestUpdate: any | null; // Latest game update for chart
  recentChatMessages: ChatMessage[]; // Last 4 chat messages
  recentRounds: Array<{ roundId: number; multiplier: number }>; // Last 6 rounds' results
}

let currentGameState: CurrentGameState = {
  roundId: null,
  gameState: 'preparing',
  currentMultiplier: 1.00,
  bettingCloseTime: null,
  latestUpdate: null,
  recentChatMessages: [],
  recentRounds: []
};

async function runGame(
  network: typeof NETWORKS[keyof typeof NETWORKS],
  contract: ethers.Contract,
  entropy: ethers.Contract,
  provider: ethers.Provider,
  broadcastStatus: (status: string, data?: any) => void,
  broadcastUpdate: (update: any) => void
) {
  // Update global state
  currentGameState = {
    roundId: null,
    gameState: 'preparing',
    currentMultiplier: 1.00,
    bettingCloseTime: null,
    latestUpdate: null,
    recentChatMessages: chatMessages.slice(-MAX_CHAT_MESSAGES),
    recentRounds: currentGameState.recentRounds || []
  };

  // Send initial status
  broadcastStatus('preparing_game', { message: 'Preparing new game...' });
  console.log(`Sent status: preparing_game\n`);

  // Step 1: Generate and commit server seed
  console.log(`Step 1: Generating server seed...`);
  const serverSeed = generateServerSeed();
  const serverSeedHash = computeServerSeedHash(serverSeed);
  console.log(`   Server Seed Hash: ${serverSeedHash}`);
  console.log(`   Server Seed: [SECRET - will be revealed after game ends]\n`);

  // Step 2: Create round with committed server seed hash
  console.log(`Step 2: Creating round with server seed hash commitment...`);
  const createTx = await contract.createRound(serverSeedHash);
  const createReceipt = await createTx.wait();
  // Get the roundId from the transaction receipt
  let roundId = await contract.roundCounter() - 1n; // Subtract 1 because roundCounter was incremented
  console.log(`Round ${roundId} created`);
  console.log(`   TX: ${network.blockExplorer}/tx/${createTx.hash}\n`);

  // Step 3-4: Request randomness and wait for callback
  console.log(`Step 3-4: Requesting randomness from Pyth Entropy...`);

  let entropyResult: { sequenceNumber: bigint; entropyRandom: bigint } | null = null;
  let currentRoundId = roundId;
  let newRequestCount = 0;

  while (!entropyResult) {
    newRequestCount++;

    if (newRequestCount > 1) {
      console.log(`\nAttempting new randomness request for Round ${currentRoundId} (attempt #${newRequestCount})...\n`);
    }

    try {
      entropyResult = await requestAndWaitForEntropy(
        {
          entropy,
          contract,
          network: {
            chainId: network.chainId,
            blockExplorer: network.blockExplorer,
            revealDelayBlocks: network.revealDelayBlocks,
          },
          provider,
        },
        // Request function
        async (roundId: number, fee: bigint) => {
          return await contract.requestRandomness(roundId, { value: fee });
        },
        // Read entropy value function
        async (roundId: number) => {
          const roundData = await contract.getRound(roundId);
          // getRound now returns: (serverSeedHash, serverSeed, sequenceNumber, entropyRandom, status)
          // Handle both array and object return types
          // Debug: log the roundData structure
          // if (Array.isArray(roundData)) {
          //   console.log(`   [DEBUG] getRound(${roundId}) returned array with ${roundData.length} elements`);
          //   console.log(`   [DEBUG] roundData[0] (serverSeedHash): ${roundData[0]}`);
          //   console.log(`   [DEBUG] roundData[1] (serverSeed): ${roundData[1]?.slice(0, 20)}...`);
          //   console.log(`   [DEBUG] roundData[2] (sequenceNumber): ${roundData[2]}`);
          //   console.log(`   [DEBUG] roundData[3] (entropyRandom): ${roundData[3]}`);
          //   console.log(`   [DEBUG] roundData[4] (status): ${roundData[4]}`);
          // } else {
          //   console.log(`   [DEBUG] getRound(${roundId}) returned object`);
          //   console.log(`   [DEBUG] entropyRandom from object: ${roundData.entropyRandom}`);
          // }
          const entropyRandom = Array.isArray(roundData) ? roundData[3] : roundData.entropyRandom;
          if (!entropyRandom || entropyRandom === 0n) {
            throw new Error('Entropy not received yet');
          }
          // console.log(`   [DEBUG] Using entropyRandom: ${entropyRandom.toString()}`);
          return entropyRandom;
        },
        Number(currentRoundId)
      );

      // Update roundId to the current one
      roundId = currentRoundId;
      break;

    } catch (error: any) {
      // If randomness request/callback failed, log and request a new round
      console.error(`\nFailed to complete randomness request/callback for Round ${currentRoundId}:`);
      console.error(`   Error: ${error.message}`);

      // Wait a bit before requesting a new round
      const waitTime = 3;
      console.log(`\nWaiting ${waitTime} seconds before requesting new round...`);
      console.log(`   Will keep trying until we succeed...\n`);
      await new Promise(resolve => setTimeout(resolve, waitTime * 1000));

      // Create a new round with the same server seed hash
      console.log(`Creating new round for retry...`);
      const createTx = await contract.createRound(serverSeedHash);
      await createTx.wait();
      currentRoundId = await contract.roundCounter() - 1n;
      console.log(`New Round ${currentRoundId} created for retry\n`);
    }
  }

  if (!entropyResult) {
    throw new Error('Failed to receive randomness after multiple attempts');
  }

  const { entropyRandom, sequenceNumber } = entropyResult;

  if (!entropyRandom) {
    throw new Error('Entropy random is null');
  }

  // Step 5: Generate game using Entropy + server seed (OFF-CHAIN, SECRET)
  console.log(`Step 5: Generating game from Entropy + server seed...`);
  console.log(`   [Server seed is SECRET - game outcome is hidden]\n`);

  const startTimestamp = Math.floor(Date.now() / 1000);
  const tickIntervalMs = 100;
  const bettingDuration = 20000; // 20 seconds in milliseconds
  const bettingCloseTime = startTimestamp + (bettingDuration / 1000); // Unix timestamp when betting closes

  // Generate the game - use the calculated finalMultiplier from the formula, not from random walk
  // This ensures consistency with frontend verification
  const gameResult = generateCrashGame({
    roundId: Number(roundId),
    vrfRandom: entropyRandom.toString(), // Use entropyRandom as vrfRandom (same purpose)
    serverSeed,
    chainId: network.chainId,
    startTimestamp: startTimestamp.toString(),
    tickIntervalMs
  });
  const updates = gameResult.updates;
  const finalMultiplier = gameResult.finalMultiplier; // Use the calculated multiplier, not random walk result
  console.log(`Game generated`);
  console.log(`   Final Multiplier: ${finalMultiplier}x [SECRET until game ends]`);
  console.log(`   Total Ticks: ${updates.length}\n`);

  // Track active round
  activeRounds.set(Number(roundId), {
    roundId: roundId,
    currentMultiplier: 1.00,
    state: 'betting'
  });
  activeCashOuts.set(Number(roundId), []); // Initialize cash-outs array

  // Update global state
  currentGameState = {
    roundId: Number(roundId),
    gameState: 'betting',
    currentMultiplier: 1.00,
    bettingCloseTime: bettingCloseTime,
    latestUpdate: null,
    recentChatMessages: chatMessages.slice(-MAX_CHAT_MESSAGES),
    recentRounds: currentGameState.recentRounds || []
  };

  // Send "betting_open" status with betting close time
  broadcastStatus('betting_open', {
    roundId: Number(roundId),
    bettingCloseTime: bettingCloseTime
  });
  console.log(`Sent status: betting_open (betting closes at ${new Date(bettingCloseTime * 1000).toISOString()})\n`);

  // Wait until betting closes (20 seconds)
  const now = Math.floor(Date.now() / 1000);
  const waitTime = Math.max(0, (bettingCloseTime - now) * 1000);
  if (waitTime > 0) {
    console.log(`Waiting ${waitTime / 1000} seconds for betting to close...\n`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }

  // Update global state
  currentGameState.gameState = 'prepared';
  currentGameState.bettingCloseTime = null;

  // Send "prepared" status - server has prepared the game data
  broadcastStatus('prepared', {
    roundId: Number(roundId),
    message: 'Game data prepared. Starting in 5 seconds...'
  });
  console.log(`Sent status: prepared\n`);

  // Both server and client wait 5 seconds
  console.log(`Waiting 5 seconds before starting game...\n`);
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Step 6: Stream game ticks
  console.log(`Step 6: Streaming game ticks...`);
  console.log(`   [Only current multiplier is sent - crash point is hidden]\n`);

  // Find the first RUNNING update (gameState === 2)
  let firstRunningIndex = -1;
  for (let i = 0; i < updates.length; i++) {
    if (updates[i].gameState === 2) {
      firstRunningIndex = i;
      break;
    }
  }

  // Update round state to running
  const activeRound = activeRounds.get(Number(roundId));
  if (activeRound) {
    activeRound.state = 'running';
  }

  // Send "game_started" status right before we start streaming RUNNING updates
  if (firstRunningIndex >= 0) {
    // Update global state
    currentGameState.gameState = 'running';
    currentGameState.currentMultiplier = 1.00;

    broadcastStatus('game_started', { roundId: Number(roundId) });
    console.log(`Sent status: game_started\n`);

    // Immediately send a synthetic 1.00x update to ensure chart shows data immediately
    // This prevents any visual gap while maintaining on-chain status recording
    const syntheticStartUpdate = {
      currentValue: 100000, // 1.00x
      bar: {
        open: 1.00,
        high: 1.00,
        low: 1.00,
        close: 1.00,
        time: updates[firstRunningIndex].bar.time
      },
      // timestamp will be added by broadcastUpdate (current server time)
      gameState: 2, // RUNNING
      nextGameNoMoreBetsAt: updates[firstRunningIndex].nextGameNoMoreBetsAt
    };
    broadcastUpdate(syntheticStartUpdate);
    currentGameState.latestUpdate = syntheticStartUpdate;

    // Then immediately send the first real RUNNING update
    const firstUpdate = updates[firstRunningIndex];
    broadcastUpdate(firstUpdate);
    currentGameState.latestUpdate = firstUpdate;
  }

  // Stream game updates
  for (let i = 0; i < updates.length; i++) {
    const update = updates[i];

    // Skip BETTING phase updates (gameState = 1) - they're not needed for the chart
    // The betting countdown is handled by the status messages
    if (update.gameState === 1) {
      continue; // Skip BETTING phase ticks entirely
    }

    // Skip the first RUNNING update since we already sent it
    if (i === firstRunningIndex) {
      // Log it but don't send again
      if (update.gameState === 2) {
        const multiplier = update.currentValue / 100000;
        console.log(`   Tick ${i}: ${multiplier.toFixed(2)}x`);
      }
      // Still wait for the tick interval to maintain timing
      await new Promise(resolve => setTimeout(resolve, tickIntervalMs));
      continue;
    }

    // Only send RUNNING phase updates (gameState = 2)
    // BETTING phase is handled by countdown, CRASHED phase is handled by status
    if (update.gameState === 2) {
      // Update current multiplier for cash-out validation
      const multiplier = update.currentValue / 100000;
      const activeRound = activeRounds.get(Number(roundId));
      if (activeRound) {
        activeRound.currentMultiplier = multiplier;
      }

      // Update global state
      currentGameState.currentMultiplier = multiplier;
      currentGameState.latestUpdate = update;

      broadcastUpdate(update);

      // Log to console for monitoring
      // if (i < 5 || i % 10 === 0) {
      //   console.log(`   Tick ${i}: ${multiplier.toFixed(2)}x`);
      // }
    } else if (update.gameState === 3) {
      // CRASH - send the final update and break
      // Use the pre-calculated finalMultiplier, not update.bar.high
      // (update.bar.high might differ slightly due to random walk rounding)
      const activeRound = activeRounds.get(Number(roundId));
      if (activeRound) {
        activeRound.finalMultiplier = finalMultiplier;
        activeRound.state = 'ended';
      }

      // Update global state
      currentGameState.currentMultiplier = finalMultiplier;
      currentGameState.gameState = 'ended';
      currentGameState.latestUpdate = update;

      broadcastUpdate(update);
      console.log(`   CRASH at ${finalMultiplier}x`);
      break;
    }

    // Simulate real-time tick interval
    await new Promise(resolve => setTimeout(resolve, tickIntervalMs));
  }

  console.log(`\n   Game streaming completed. Waiting 2 seconds before reveal...\n`);

  // Wait 2 seconds after game ends before revealing
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Step 7: Reveal server seed (for verification)
  console.log(`Step 7: Revealing server seed for verification...`);
  const serverSeedBytes = ethers.toUtf8Bytes(serverSeed);
  const revealTx = await contract.revealServerSeed(roundId, serverSeedBytes);
  const revealReceipt = await revealTx.wait();
  console.log(`Server seed revealed`);
  console.log(`   TX: ${network.blockExplorer}/tx/${revealTx.hash}`);
  console.log(`   Server Seed: ${serverSeed}`);
  console.log(`   [Now anyone can verify the game outcome]\n`);

  // Step 8: Settle round and process cash-outs
  const roundIdNum = Number(roundId);
  const cashOuts = activeCashOuts.get(roundIdNum) || [];
  console.log(`Step 8: Settling round ${roundIdNum} with ${cashOuts.length} cash-outs...`);

  // Settle the round (set final multiplier) - this is required before processing cash-outs
  // Note: We keep this separate from processCashOuts because:
  // 1. Gas limits - if there are many cash-outs, we need to batch them separately
  // 2. The settle operation is simple (just sets a value), while processCashOuts does calculations
  // 3. If there are no cash-outs, we still need to settle the round to mark it as complete
  const finalMultiplierWei = ethers.parseUnits(finalMultiplier.toFixed(18), 18);
  const settleTx = await contract.settleRound(
    roundId,
    finalMultiplierWei,
    serverSeedBytes
  );
  const settleReceipt = await settleTx.wait();
  console.log(`Round settled`);
  console.log(`   TX: ${network.blockExplorer}/tx/${settleTx.hash}`);
  console.log(`   Final Multiplier: ${finalMultiplier}x\n`);

  // Add to recent rounds (keep last 6)
  currentGameState.recentRounds.push({
    roundId: Number(roundId),
    multiplier: finalMultiplier
  });
  if (currentGameState.recentRounds.length > 6) {
    currentGameState.recentRounds.shift(); // Remove oldest if more than 6
  }

  // Process cash-outs in batches (to avoid gas limits)
  // Only process if there are cash-outs to avoid unnecessary transactions
  if (cashOuts.length > 0) {
    console.log(`Step 9: Processing ${cashOuts.length} cash-outs in batches...`);
    const BATCH_SIZE = 15; // Process 15 cash-outs per transaction to avoid gas limits

    // Convert cash-outs to contract format
    const cashOutData = cashOuts.map(co => ({
      wallet: co.walletAddress,
      multiplier: ethers.parseUnits(co.multiplier.toFixed(18), 18) // Convert to wei
    }));

    // Process in batches
    for (let i = 0; i < cashOutData.length; i += BATCH_SIZE) {
      const batch = cashOutData.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(cashOutData.length / BATCH_SIZE);

      console.log(`   Processing batch ${batchNum}/${totalBatches} (${batch.length} cash-outs)...`);

      const processTx = await contract.processCashOuts(roundId, batch);
      await processTx.wait();

      console.log(`   Batch ${batchNum} processed: ${network.blockExplorer}/tx/${processTx.hash}`);
    }

    console.log(`   All ${cashOuts.length} cash-outs processed\n`);
  } else {
    console.log(`   No cash-outs to process\n`);
  }

  // Clean up active round tracking
  activeRounds.delete(Number(roundId));
  activeCashOuts.delete(Number(roundId));

  // Send "revealed" status
  broadcastStatus('revealed', {
    roundId: Number(roundId),
    serverSeed,
    txHash: revealTx.hash
  });
  console.log(`Sent status: revealed\n`);

  // Wait 2 seconds after reveal, then start next game
  console.log(`Waiting 2 seconds before starting next game...\n`);
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Game completed, will loop back to start next game
  console.log(`Round ${roundId} completed. Starting next game...\n`);
}

async function main() {
  const networkName = process.env.NETWORK || 'monad-testnet';
  const network = NETWORKS[networkName as keyof typeof NETWORKS];

  if (!network) {
    throw new Error(`Unknown network: ${networkName}`);
  }

  const privateKey = process.env.DEPLOYER_PK;
  if (!privateKey) {
    throw new Error('DEPLOYER_PK not found');
  }

  // Try to get contract address from env or deployment file
  let contractAddress: string | undefined = process.env.CRASH_GAME_CONTRACT;
  if (!contractAddress) {
    const deploymentPath = path.resolve(__dirname, `../deployments/crash-game-${networkName}.json`);
    if (fs.existsSync(deploymentPath)) {
      const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf-8'));
      contractAddress = deployment.contractAddress;
      console.log(`Using contract address from deployment file: ${contractAddress}\n`);
    } else {
      throw new Error('CRASH_GAME_CONTRACT not set. Deploy the CrashGame contract first with: npm run deploy');
    }
  }

  if (!contractAddress) {
    throw new Error('CRASH_GAME_CONTRACT is required');
  }

  const provider = new ethers.JsonRpcProvider(network.rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  const contractPath = path.resolve(__dirname, "../artifacts/contracts/CrashGame.sol/CrashGame.json");
  const contractArtifact = JSON.parse(fs.readFileSync(contractPath, 'utf-8'));
  const contract = new ethers.Contract(contractAddress, contractArtifact.abi, wallet);

  const entropy = new ethers.Contract(network.entropy, PYTH_ENTROPY_ABI, wallet);

  console.log(`\nCrash Game Server - Continuous Mode\n`);
  console.log(`Network: ${networkName}`);
  console.log(`Contract: ${contractAddress}\n`);

  // Start WebSocket server early
  const wsPort = parseInt(process.env.WS_PORT || '80');
  let wss: WebSocketServer;
  try {
    wss = new WebSocketServer({ port: wsPort, host: '0.0.0.0' }, () => {
      console.log(`WebSocket server running on ws://0.0.0.0:${wsPort}`);
    });

    const handleServerError = (error: Error) => {
      if ((error as any).code === 'EADDRINUSE') {
        console.error(`\nError: Port ${wsPort} is already in use.`);
        process.exit(1);
      } else {
        console.error(`\nWebSocket server error: ${error.message}\n`);
        process.exit(1);
      }
    };

    wss.on('error', handleServerError);
    (wss as any).server?.on('error', handleServerError);

    wss.on('listening', () => {
      console.log(`WebSocket server listening on ws://localhost:${wsPort}\n`);
    });
  } catch (error: any) {
    if (error.code === 'EADDRINUSE') {
      console.error(`\nError: Port ${wsPort} is already in use.`);
      process.exit(1);
    }
    throw error;
  }

  const clients = new Set<WebSocket>();

  // Helper function to handle cash-out requests
  async function handleCashOutRequest(ws: WebSocket, message: any, contract: ethers.Contract, provider: ethers.Provider) {
    const { roundId, multiplier, walletAddress } = message;

    console.log(`   Processing cash-out: roundId=${roundId} (type: ${typeof roundId}), multiplier=${multiplier}, wallet=${walletAddress}`);

    if (!roundId || !multiplier || !walletAddress) {
      console.log(`   Cash-out rejected: Missing required fields`);
      ws.send(JSON.stringify({
        type: 'cash_out_response',
        success: false,
        error: 'Missing required fields'
      }));
      return;
    }

    // Ensure roundId is a number
    const roundIdNum = typeof roundId === 'string' ? parseInt(roundId) : roundId;

    // 1. Verify round is active and in RUNNING state
    const activeRound = activeRounds.get(roundIdNum);
    // console.log(`   Active round check: ${activeRound ? `found, state=${activeRound.state}` : 'not found'}`);
    if (!activeRound || activeRound.state !== 'running') {
      console.log(`   Cash-out rejected: Round not active (state: ${activeRound?.state || 'not found'})`);
      ws.send(JSON.stringify({
        type: 'cash_out_response',
        success: false,
        error: 'Round not active'
      }));
      return;
    }

    // 2. Verify multiplier is valid (between 1.00x and current max)
    if (multiplier < 1.00 || multiplier > activeRound.currentMultiplier) {
      console.log(`   Cash-out rejected: Invalid multiplier (${multiplier}, max: ${activeRound.currentMultiplier})`);
      ws.send(JSON.stringify({
        type: 'cash_out_response',
        success: false,
        error: 'Invalid multiplier'
      }));
      return;
    }

    // 3. Check if user has a bet for this round (on-chain check)
    try {
      const bet = await contract.getBet(roundIdNum, walletAddress);
      // console.log(`   Bet check: amount=${bet.amount.toString()}`);
      if (bet.amount === 0n) {
        console.log(`   Cash-out rejected: No bet found`);
        ws.send(JSON.stringify({
          type: 'cash_out_response',
          success: false,
          error: 'No bet found'
        }));
        return;
      }

      // 4. Check if already cashed out
      const existingCashOuts = activeCashOuts.get(roundIdNum) || [];
      console.log(`   Existing cash-outs for round ${roundIdNum}: ${existingCashOuts.length}`);
      if (existingCashOuts.some(co => co.walletAddress.toLowerCase() === walletAddress.toLowerCase())) {
        console.log(`   Cash-out rejected: Already cashed out`);
        ws.send(JSON.stringify({
          type: 'cash_out_response',
          success: false,
          error: 'Already cashed out'
        }));
        return;
      }

      // 5. Record cash-out
      const cashOut: CashOut = {
        walletAddress: walletAddress.toLowerCase(),
        multiplier: multiplier,
        timestamp: Date.now() / 1000,
        verified: true
      };

      activeCashOuts.set(roundIdNum, [...existingCashOuts, cashOut]);
      console.log(`   Cash-out recorded! Round ${roundIdNum} now has ${activeCashOuts.get(roundIdNum)?.length || 0} cash-outs`);

      // 6. Calculate payout with house edge (1.5%)
      const betAmount = Number(ethers.formatUnits(bet.amount, 18));
      const payoutBeforeFee = betAmount * multiplier;
      let payout = payoutBeforeFee * (1 - HOUSE_EDGE);

      // 7. Apply max win per round per player (70% of contract balance)
      try {
        const tokenAddress = await contract.token();
        const tokenContract = new ethers.Contract(tokenAddress, TOKEN_ABI, provider);
        const contractAddress = await contract.getAddress();
        const contractBalance = await tokenContract.balanceOf(contractAddress);
        const contractBalanceNum = Number(ethers.formatUnits(contractBalance, 18));
        const maxWinPerPlayer = contractBalanceNum * MAX_WIN_PERCENTAGE;

        if (payout > maxWinPerPlayer) {
          payout = maxWinPerPlayer;
          console.log(`   Payout capped at max win (70% of contract balance): ${payout.toFixed(2)} tokens (contract balance: ${contractBalanceNum.toFixed(2)})`);
        }
      } catch (error: any) {
        console.error(`   Warning: Could not check contract balance for max win limit: ${error.message}`);
        // Continue with calculated payout if we can't check balance
      }

      // 8. Send confirmation
      ws.send(JSON.stringify({
        type: 'cash_out_response',
        success: true,
        roundId: roundId,
        multiplier: multiplier,
        payout: payout
      }));

      console.log(`   Cash-out recorded: ${walletAddress} at ${multiplier.toFixed(2)}x (payout: ${payout.toFixed(2)} tokens)`);
    } catch (error: any) {
      console.error(`   Error processing cash-out: ${error.message}`);
      ws.send(JSON.stringify({
        type: 'cash_out_response',
        success: false,
        error: 'Failed to verify bet'
      }));
    }
  }

  wss.on('connection', (ws: WebSocket) => {
    console.log(`   Client connected (${clients.size + 1} total)`);
    clients.add(ws);

    // Send current game state immediately when client connects
    const stateMessage = JSON.stringify({
      type: 'state_snapshot',
      ...currentGameState,
      recentChatMessages: chatMessages.slice(-MAX_CHAT_MESSAGES) // Send last 4 messages
    });

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(stateMessage);
      console.log(`   Sent state snapshot to new client: roundId=${currentGameState.roundId}, state=${currentGameState.gameState}, multiplier=${currentGameState.currentMultiplier.toFixed(2)}x`);
    }

    // Handle incoming messages from clients
    ws.on('message', async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.type === 'cash_out') {
          // console.log(`   Received cash-out request: roundId=${message.roundId}, multiplier=${message.multiplier}, wallet=${message.walletAddress}`);
          await handleCashOutRequest(ws, message, contract, provider);
        } else if (message.type === 'chat_message') {
          const { address, message: chatText } = message;
          if (address && chatText && chatText.trim()) {
            // Limit message to 5000 characters
            const trimmedMessage = chatText.trim().slice(0, 5000);
            if (trimmedMessage.length === 0) {
              return; // Don't send empty messages
            }

            const chatMessage: ChatMessage = {
              id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
              user: formatAddress(address),
              address: address.toLowerCase(),
              message: trimmedMessage,
              timestamp: Date.now() / 1000
            };

            // Add to chat messages array
            chatMessages.push(chatMessage);

            // Keep only last MAX_CHAT_MESSAGES messages
            if (chatMessages.length > MAX_CHAT_MESSAGES) {
              chatMessages.shift();
            }

            // Update current game state
            currentGameState.recentChatMessages = chatMessages.slice(-MAX_CHAT_MESSAGES);

            // Broadcast to all clients
            const broadcastMessage = JSON.stringify({
              type: 'chat_message',
              ...chatMessage
            });

            clients.forEach((client) => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(broadcastMessage);
              }
            });

            console.log(`   Chat message from ${chatMessage.user}: ${chatMessage.message.substring(0, 50)}`);
          }
        }
      } catch (error: any) {
        console.error(`   Error handling message: ${error.message}`);
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      console.log(`   Client disconnected (${clients.size} remaining)`);
    });

    ws.on('error', (error: Error) => {
      console.error(`   WebSocket error: ${error.message}`);
    });
  });

  // Helper function to broadcast status messages
  const broadcastStatus = (status: string, data?: any) => {
    const message = JSON.stringify({ type: 'status', status, ...data });
    clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  };

  // Helper function to broadcast game updates
  const broadcastUpdate = (update: any) => {
    // Add current server timestamp when sending (not pre-calculated)
    // This provides accurate timestamps without revealing crash timing
    const updateWithTimestamp = {
      ...update,
      timestamp: Date.now() / 1000 // Current server Unix timestamp with decimal precision
    };
    const message = JSON.stringify({ type: 'update', ...updateWithTimestamp });
    clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  };

  // Continuous game loop
  console.log(`Starting continuous game loop...\n`);
  console.log(`Press Ctrl+C to stop\n`);

  while (true) {
    try {
      await runGame(network, contract, entropy, provider, broadcastStatus, broadcastUpdate);
    } catch (error: any) {
      console.error(`\nError in game round: ${error.message}`);
      console.error(`   Will retry in 5 seconds...\n`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log(`\n\nStopping crash game server...\n`);
  process.exit(0);
});

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
