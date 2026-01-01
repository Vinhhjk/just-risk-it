import { ethers } from "ethers";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import dotenv from 'dotenv';

// Resolve __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, "../.env") });

// Network configuration
interface NetworkConfig {
  chainId: number;
  rpcUrl: string;
  entropy: string;
  blockExplorer: string;
  revealDelayBlocks: number;
}

const NETWORKS: Record<string, NetworkConfig> = {
  'monad-testnet': {
    chainId: 10143,
    rpcUrl: 'https://testnet-rpc.monad.xyz',
    entropy: '0x825c0390f379c631f3cf11a82a37d20bddf93c07', // Pyth Entropy on Monad testnet
    blockExplorer: 'https://testnet.monadexplorer.com',
    revealDelayBlocks: 2, // Reveal delay is 2 blocks
  },
};

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const networkName = 'monad-testnet';
  const network = NETWORKS[networkName as keyof typeof NETWORKS];
  
  if (!network) {
    throw new Error(`Unknown network: ${networkName}`);
  }

  const privateKey = process.env.DEPLOYER_PK;
  if (!privateKey) {
    throw new Error('DEPLOYER_PK not found in environment variables');
  }

  // Get contract address from deployment file
  const deploymentPath = path.resolve(__dirname, `../deployments/pyth-test-${networkName}.json`);
  if (!fs.existsSync(deploymentPath)) {
    throw new Error('Contract not deployed. Run: npm run deploy-pyth-test');
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf-8'));
  const contractAddress = deployment.contractAddress;

  console.log(`\n🧪 Testing Pyth Entropy on ${networkName}...`);
  console.log(`Contract: ${contractAddress}\n`);

  // Setup provider and wallet
  const provider = new ethers.JsonRpcProvider(network.rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  
  console.log(`Wallet address: ${wallet.address}\n`);

  // Read contract artifact
  const contractArtifactPath = path.resolve(__dirname, "../artifacts/contracts/PythEntropyTest.sol/PythEntropyTest.json");
  if (!fs.existsSync(contractArtifactPath)) {
    throw new Error('Contract not compiled. Run: npm run compile');
  }
  const contractArtifact = JSON.parse(fs.readFileSync(contractArtifactPath, 'utf-8'));
  const contract = new ethers.Contract(contractAddress, contractArtifact.abi, wallet);

  // ==========================================================================
  // Step 1: Request Random Number
  // ==========================================================================
  console.log('Step 1: Requesting random number...');
  
  // Get the fee first
  const entropyAddress = await contract.entropy();
  const entropyABI = [
    'function getFeeV2() external view returns (uint256)',
  ];
  const entropy = new ethers.Contract(entropyAddress, entropyABI, wallet);
  
  const fee = await entropy.getFeeV2();
  console.log(`   Fee: ${ethers.formatEther(fee)} MON\n`);

  // Request random number
  const requestTx = await contract.requestRandomNumber({ value: fee });
  const requestReceipt = await requestTx.wait();

  // Get sequence number from event
  const requestEvent = requestReceipt.logs.find((log: any) => {
    try {
      const parsed = contract.interface.parseLog(log);
      return parsed && parsed.name === 'RandomNumberRequested';
    } catch {
      return false;
    }
  });

  let sequenceNumber: bigint | null = null;
  if (requestEvent) {
    const parsed = contract.interface.parseLog(requestEvent);
    sequenceNumber = parsed?.args[0];
  }

  console.log(`Random number requested in block ${requestReceipt.blockNumber}`);
  console.log(`TX: ${network.blockExplorer}/tx/${requestTx.hash}`);
  if (sequenceNumber !== null) {
    console.log(`Sequence Number: ${sequenceNumber}\n`);
  } else {
    console.log(`Could not extract sequence number from event\n`);
  }

  // ==========================================================================
  // Step 2: Wait for Callback
  // ==========================================================================
  console.log('Step 2: Waiting for entropy callback...');
  console.log(`   Note: Pyth Entropy delivers randomness via callback.`);
  console.log(`   Reveal delay: ${network.revealDelayBlocks} blocks`);
  console.log(`   The callback will be called by the Entropy contract in a separate transaction.\n`);

  // Wait for at least the reveal delay blocks
  const currentBlock = await provider.getBlockNumber();
  const targetBlock = currentBlock + network.revealDelayBlocks;
  console.log(`   Current block: ${currentBlock}, waiting for block ${targetBlock}...`);
  
  // Wait for blocks to pass
  while ((await provider.getBlockNumber()) < targetBlock) {
    await sleep(1000); // Check every second
  }
  console.log(`   Reveal delay passed.\n`);

  // Poll for the random number (callback sets it)
  let randomNumber: bigint | null = null;
  let maxWaitTime = 120; // Wait up to 120 seconds
  let waited = 0;
  const pollInterval = 3; // Poll every 3 seconds

  while (waited < maxWaitTime && randomNumber === null) {
    await sleep(pollInterval * 1000);
    waited += pollInterval;

    try {
      const currentRandom = await contract.randomNumber();
      if (currentRandom !== 0n) {
        randomNumber = currentRandom;
        console.log(`Random number received via callback!`);
        break;
      }
    } catch (e: any) {
      // Continue polling
    }

    if (waited < maxWaitTime) {
      console.log(`   Waiting for callback... (${waited}s/${maxWaitTime}s)`);
    }
  }

  if (randomNumber === null) {
    throw new Error(`Random number not received after ${maxWaitTime} seconds. The callback may have failed.`);
  }

  // ==========================================================================
  // Step 3: Use the Random Value
  // ==========================================================================
  console.log('Step 3: Using random value...');
  
  console.log(`\n✅ Randomness Successfully Generated!`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Random Value (256-bit): ${randomNumber}`);
  console.log(`\nExample Use Cases:`);
  console.log(`  • 0-99: ${Number(randomNumber % 100n)}`);
  console.log(`  • Coin flip: ${randomNumber % 2n === 0n ? 'Heads' : 'Tails'}`);
  console.log(`  • D6 roll: ${Number((randomNumber % 6n) + 1n)}`);
  console.log(`  • D20 roll: ${Number((randomNumber % 20n) + 1n)}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
