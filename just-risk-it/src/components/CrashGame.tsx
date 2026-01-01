import { useState, useRef, useEffect } from 'react';
import { useWebSocket, type GameUpdate, type StatusMessage, type CashOutResponse, type StateSnapshot, type ChatMessage } from '../hooks/useWebSocket';
import { CrashGameChart } from './CrashGameChart';
import { PlayerList } from './PlayerList';
import { Chat } from './Chat';
import { ConnectWalletButton } from './ConnectWallet';
import { ClaimTokenButton } from './ClaimTokenButton';
import { useWallets } from '@privy-io/react-auth';
import { formatAddress } from '../utils/formatAddress';
import { createPublicClient, createWalletClient, http, formatUnits, parseUnits, custom, encodeFunctionData } from 'viem';
import { monadTestnet } from 'wagmi/chains';
import MockChogTokenABI from '../contracts/MockChogToken.json';
import CrashGameABI from '../contracts/CrashGame.json';
import type { Time } from 'lightweight-charts';

// Monad Testnet chain configuration for network switching
const MONAD_TESTNET_CHAIN = {
  id: 10143,
  name: 'Monad Testnet',
  network: 'monad-testnet',
  nativeCurrency: {
    decimals: 18,
    name: 'MON',
    symbol: 'MON',
  },
  rpcUrls: {
    default: {
      http: ['https://testnet-rpc.monad.xyz'],
    },
    public: {
      http: ['https://testnet-rpc.monad.xyz'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Monad Explorer',
      url: 'https://testnet.monadexplorer.com',
    },
  },
  testnet: true,
};
import { GrGroup } from 'react-icons/gr';
import { FaDice, FaGithub, FaCopy } from 'react-icons/fa';
import { IoChatbubbleOutline } from 'react-icons/io5';

const WS_URL = import.meta.env.VITE_WS_URL;

interface ChartDataPoint {
  time: Time;
  open: number;
  high: number;
  low: number;
  close: number;
}

export function CrashGame() {
  const [gameState, setGameState] = useState<number>(1); // 1 = BETTING, 2 = RUNNING, 3 = CRASHED
  const [currentMultiplier, setCurrentMultiplier] = useState(1.00);
  const [chartData, setChartData] = useState<ChartDataPoint[]>([]);
  const [status, setStatus] = useState<string>('Connecting...');
  const [roundId, setRoundId] = useState<number | null>(null);
  const [betAmount, setBetAmount] = useState<string>('0.01');
  const [hasBet, setHasBet] = useState(false);
  const [cashOutMultiplier, setCashOutMultiplier] = useState<number | null>(null);
  const [players, setPlayers] = useState<Array<{ id: string; name: string; bet: number; cashOut?: number; payout?: number; status: 'pending' | 'cashed_out' | 'crashed' }>>([]);
  const [chatMessages, setChatMessages] = useState<Array<{ id: string; user: string; message: string; timestamp: number }>>([]);
  const { wallets } = useWallets();
  const tickCounterRef = useRef(0);
  const candleStartTimestampRef = useRef<number | null>(null); // Store timestamp when a new candle starts
  const [bettingCloseTime, setBettingCloseTime] = useState<number | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [countdownType, setCountdownType] = useState<'betting' | 'prepared' | null>(null);
  const [bettingStatus, setBettingStatus] = useState<'preparing' | 'open' | 'closed' | null>(null); // Track betting status explicitly
  const [recentRounds, setRecentRounds] = useState<Array<{ roundId: number; multiplier: number }>>([]); // Last 6 rounds' results
  const [tokenBalance, setTokenBalance] = useState<string>('0.00'); // Wallet balance
  const [claimablePayouts, setClaimablePayouts] = useState<string>('0.00'); // Claimable payouts in contract
  const [isClaiming, setIsClaiming] = useState(false);
  const [isBetting, setIsBetting] = useState(false); // Loading state for betting/depositing
  const [mobileView, setMobileView] = useState<'players' | 'betting' | 'chat'>('players'); // Mobile navigation state

  const MOCK_TOKEN_ADDRESS = import.meta.env.VITE_MOCK_TOKEN as `0x${string}`;
  const CRASH_GAME_ADDRESS = import.meta.env.VITE_CRASH_GAME_CONTRACT as `0x${string}`;
  const tokenABI = MockChogTokenABI.abi;
  const crashGameABI = CrashGameABI.abi;

  const handleStatus = (statusMsg: StatusMessage) => {
    switch (statusMsg.status) {
      case 'preparing_game':
        setStatus('Preparing game...');
        setGameState(1);
        setChartData([]);
        setCurrentMultiplier(1.00);
        setHasBet(false);
        setCashOutMultiplier(null);
        setPlayers([]); // Clear players for new round
        tickCounterRef.current = 0;
        candleStartTimestampRef.current = null;
        setBettingCloseTime(null);
        setCountdown(null);
        setCountdownType(null);
        setBettingStatus('preparing'); // Mark as preparing - betting not open yet
        break;
      case 'betting_open':
        setStatus('Betting is open');
        setGameState(1);
        setRoundId(statusMsg.roundId || null);
        setBettingStatus('open'); // Mark as open - betting is allowed
        if (statusMsg.bettingCloseTime) {
          setBettingCloseTime(statusMsg.bettingCloseTime);
          setCountdownType('betting');
        }
        break;
      case 'prepared':
        setStatus('Game prepared. Starting in 5 seconds...');
        setRoundId(statusMsg.roundId || null);
        setBettingCloseTime(null);
        setCountdownType('prepared');
        setBettingStatus('closed'); // Mark as closed - betting no longer allowed
        setCountdown(5); // Start 5 second countdown
        break;
      case 'game_started':
        setStatus('Game is running!');
        setGameState(2);
        setCountdown(null);
        setCountdownType(null);
        // Reset chart data and counter - wait for first real update with server timestamp
        setChartData([]);
        tickCounterRef.current = 0;
        candleStartTimestampRef.current = null;
        setCurrentMultiplier(1.00);
        break;
      case 'revealed':
        setStatus('Game ended. Seed revealed.');
        setGameState(3);
        setCountdown(null);
        setCountdownType(null);
        break;
    }
  };

  const handleUpdate = (update: GameUpdate) => {
    const multiplier = update.currentValue / 100000;
    setCurrentMultiplier(multiplier);
    setGameState(update.gameState);

    // Check if crashed (before filtering)
    if (update.gameState === 3) {
      setStatus(`Rewarding players`);
      // Add to recent rounds when game crashes
      if (roundId !== null && multiplier > 0) {
        setRecentRounds((prev) => {
          const newRounds = [...prev, { roundId, multiplier }];
          // Keep only last 6 rounds
          return newRounds.slice(-6);
        });
      }
      if (hasBet && cashOutMultiplier === null) {
        // Player didn't cash out, they lost
        const walletAddress = wallets[0]?.address;
        if (walletAddress) {
          setPlayers((prev) =>
            prev.map((p) =>
              p.id === walletAddress
                ? { ...p, status: 'crashed' as const }
                : p
            )
          );
        }
        setHasBet(false);
      }
      // Mark all pending players as crashed
      setPlayers((prev) =>
        prev.map((p) =>
          p.status === 'pending' ? { ...p, status: 'crashed' as const } : p
        )
      );
    }

    // Add chart data for both RUNNING (gameState === 2) and CRASHED (gameState === 3) states
    // Skip BETTING phase (gameState === 1)
    if (update.gameState === 1) {
      return;
    }

    // Use the actual multiplier for close value to ensure it matches the display
    const multiplierClose = multiplier;
    const open = update.bar.open;
    const high = Math.max(update.bar.high, multiplierClose); // Ensure high includes current multiplier
    const low = Math.min(update.bar.low, multiplierClose); // Ensure low includes current multiplier
    const close = multiplierClose; // Use actual multiplier, not bar.close

    setChartData((prev) => {
      // If crashed, always update the last candle to show the crash value (don't create disconnected candle)
      if (update.gameState === 3) {
        if (prev.length === 0) {
          // Edge case: crash on first update
          const serverTimestamp = update.timestamp || Math.floor(Date.now() / 1000);
          return [{ time: serverTimestamp as Time, open, high, low, close }];
        }
        // Update the last candle with crash values to ensure it connects
        const updated = [...prev];
        const lastCandle = updated[updated.length - 1];
        updated[updated.length - 1] = {
          time: lastCandle.time, // Keep original timestamp to maintain connection
          open: lastCandle.open, // Keep original open
          high: Math.max(lastCandle.high, high), // Update high to include crash value
          low: Math.min(lastCandle.low, low), // Update low
          close: close, // Update close to match crash multiplier
        };
        return updated;
      }

      // For RUNNING state, continue with normal candle aggregation
      // Server sends current Unix timestamp when each update is sent
      // This provides accurate timestamps without revealing crash timing
      const serverTimestamp = update.timestamp || Math.floor(Date.now() / 1000);

      // Group ticks into candles (each candle represents multiple ticks)
      // Reduced to 5 ticks per candle for better visibility during testing
      const ticksPerCandle = 5; // Create a new candle every 5 ticks

      // If this is the first update, start with this data
      if (prev.length === 0) {
        // Initialize tick counter to 1 for the first tick
        tickCounterRef.current = 1;
        // Store the base timestamp for the first candle
        candleStartTimestampRef.current = serverTimestamp;
        return [{ time: serverTimestamp as Time, open, high, low, close }];
      }

      // Increment tick counter for subsequent updates
      tickCounterRef.current += 1;
      const currentTick = tickCounterRef.current;

      // Check if we should create a new candle (at ticks 5, 10, 15, etc.)
      // This happens when we complete a full group of ticks
      if (currentTick % ticksPerCandle === 0 && currentTick > 0) {
        // New candle - use the stored server timestamp from the first tick of this candle group
        // The stored timestamp is from tick 1, 6, 11, etc. (first tick of each group)
        // This ensures we use the actual server timestamps, not calculated ones
        const candleTimestamp = candleStartTimestampRef.current || serverTimestamp;

        const newData = [...prev, { time: candleTimestamp as Time, open, high, low, close }];
        // Keep only last 1000 points for performance
        return newData.slice(-1000);
      } else {
        // Check if this is the first tick of a new candle group (tick 1, 6, 11, etc.)
        // Store its timestamp for use when creating the candle at the end of the group
        if ((currentTick - 1) % ticksPerCandle === 0) {
          candleStartTimestampRef.current = serverTimestamp;
        }
        // Update last candle with new high/low/close (keep original timestamp)
        const updated = [...prev];
        const lastCandle = updated[updated.length - 1];
        updated[updated.length - 1] = {
          time: lastCandle.time, // Keep original timestamp
          open: lastCandle.open, // Keep original open
          high: Math.max(lastCandle.high, high), // Update high
          low: Math.min(lastCandle.low, low), // Update low
          close: close, // Update close to match current multiplier
        };
        return updated;
      }
    });
  };

  const { sendMessage } = useWebSocket({
    url: WS_URL,
    onStatus: handleStatus,
    onUpdate: handleUpdate,
    onStateSnapshot: (snapshot: StateSnapshot) => {
      // Restore game state immediately when connecting
      if (snapshot.roundId !== null) {
        setRoundId(snapshot.roundId);
        setCurrentMultiplier(snapshot.currentMultiplier);

        // Restore chat messages from snapshot
        if (snapshot.recentChatMessages && snapshot.recentChatMessages.length > 0) {
          setChatMessages(snapshot.recentChatMessages.map(msg => ({
            id: msg.id,
            user: msg.user,
            message: msg.message,
            timestamp: msg.timestamp * 1000 // Convert to milliseconds
          })));
        }

        // Restore recent rounds
        if (snapshot.recentRounds) {
          setRecentRounds(snapshot.recentRounds);
        }

        // Set game state based on snapshot
        if (snapshot.gameState === 'betting') {
          setGameState(1);
          setStatus('Betting is open');
          setBettingStatus('open'); // Mark as open
          if (snapshot.bettingCloseTime) {
            setBettingCloseTime(snapshot.bettingCloseTime);
            setCountdownType('betting');
          }
        } else if (snapshot.gameState === 'prepared') {
          setGameState(1);
          setStatus('Game prepared. Starting soon...');
          setCountdownType('prepared');
          setBettingStatus('closed'); // Mark as closed
          setCountdown(5);
        } else if (snapshot.gameState === 'running') {
          setGameState(2);
          setStatus('Game is running!');
          setBettingStatus('closed'); // Mark as closed
          // Process latest update if available
          if (snapshot.latestUpdate) {
            handleUpdate(snapshot.latestUpdate as GameUpdate);
          }
        } else if (snapshot.gameState === 'ended') {
          setGameState(3);
          setStatus('Game ended');
          setBettingStatus('closed'); // Mark as closed
          if (snapshot.latestUpdate) {
            handleUpdate(snapshot.latestUpdate as GameUpdate);
          }
        } else if (snapshot.gameState === 'preparing') {
          setGameState(1);
          setStatus('Preparing game...');
          setBettingStatus('preparing'); // Mark as preparing
        }

        // Restore players from snapshot
        if (snapshot.players) {
          setPlayers(snapshot.players.map(p => ({
            id: p.id,
            name: p.name,
            bet: p.bet,
            cashOut: p.cashOut,
            payout: p.payout,
            status: p.status
          })));

          // Check if current user has a bet in the snapshot
          const walletAddress = wallets[0]?.address;
          if (walletAddress) {
            const currentPlayer = snapshot.players.find(p => p.id.toLowerCase() === walletAddress.toLowerCase());
            if (currentPlayer) {
              setHasBet(true);
              if (currentPlayer.status === 'cashed_out') {
                setCashOutMultiplier(currentPlayer.cashOut || null);
              }
            }
          }
        }
      }
    },
    onPlayerJoined: (message) => {
      setPlayers((prev) => {
        // Avoid duplicates
        if (prev.some(p => p.id.toLowerCase() === message.player.id.toLowerCase())) {
          return prev;
        }
        return [...prev, {
          id: message.player.id,
          name: message.player.name,
          bet: message.player.bet,
          status: message.player.status as 'pending' | 'cashed_out' | 'crashed'
        }];
      });
    },
    onPlayerCashedOut: (message) => {
      setPlayers((prev) =>
        prev.map((p) =>
          p.id.toLowerCase() === message.player.id.toLowerCase()
            ? {
              ...p,
              cashOut: message.player.cashOut,
              payout: message.player.payout,
              status: 'cashed_out' as const,
            }
            : p
        )
      );
    },
    onChatMessage: (message: ChatMessage) => {
      setChatMessages((prev) => {
        // Avoid duplicates
        if (prev.some(m => m.id === message.id)) {
          return prev;
        }
        return [...prev, {
          id: message.id,
          user: message.user,
          message: message.message,
          timestamp: message.timestamp * 1000 // Convert to milliseconds
        }].slice(-50); // Keep last 50 messages
      });
    },
    onCashOutResponse: (response: CashOutResponse) => {
      if (response.success && response.multiplier && response.payout) {
        // Update player payout with the actual payout from server (already includes house edge)
        const walletAddress = wallets[0]?.address;
        if (walletAddress) {
          setPlayers((prev) =>
            prev.map((p) =>
              p.id === walletAddress
                ? {
                  ...p,
                  cashOut: response.multiplier!,
                  payout: response.payout!,
                  status: 'cashed_out' as const,
                }
                : p
            )
          );
        }
      } else {
        // Don't show error to user, just log it
        console.error('Cash-out failed:', response.error || 'Unknown error');
      }
    },
    onError: (error) => {
      console.error('WebSocket error:', error);
      setStatus('Connection error. Retrying...');
    },
    onOpen: () => {
      setStatus('Connected.')
    },
    onClose: () => {
      setStatus('Disconnected. Reconnecting...');
    },
  });

  // Note: eth_sendRawTransactionSync (EIP-7966) requires a raw signed transaction
  // Browser wallets don't support eth_signTransaction, so we use the standard flow
  // with writeContract and waitForTransactionReceipt

  // Check if betting is open (explicitly check bettingStatus === 'open')
  const isBettingOpen = bettingStatus === 'open';

  const handleBet = async () => {
    // Only allow betting when gameState is 1 (BETTING), has roundId, and not during the 5-second countdown (prepared state)
    if (!isBettingOpen || !roundId || isBetting) {
      return;
    }
    const walletAddress = wallets[0]?.address;
    if (!walletAddress || !CRASH_GAME_ADDRESS || !MOCK_TOKEN_ADDRESS) {
      return;
    }

    const betAmountNum = parseFloat(betAmount);
    if (isNaN(betAmountNum) || betAmountNum <= 0) {
      return;
    }

    // Check max bet (1000 tokens)
    const MAX_BET = 1000;
    if (betAmountNum > MAX_BET) {
      return;
    }

    setIsBetting(true);

    try {
      const wallet = wallets[0];
      const provider = await wallet.getEthereumProvider();
      const walletClient = createWalletClient({
        account: wallet.address as `0x${string}`,
        chain: monadTestnet,
        transport: custom(provider),
      });

      const publicClient = createPublicClient({
        chain: monadTestnet,
        transport: http(),
      });

      // Get decimals
      const decimals = await publicClient.readContract({
        address: MOCK_TOKEN_ADDRESS,
        abi: tokenABI,
        functionName: 'decimals',
      });

      const betAmountWei = parseUnits(betAmountNum.toString(), decimals as number);

      // Check wallet balance
      const walletBalance = await publicClient.readContract({
        address: MOCK_TOKEN_ADDRESS,
        abi: tokenABI,
        functionName: 'balanceOf',
        args: [walletAddress as `0x${string}`],
      }) as bigint;

      if (walletBalance < betAmountWei) {
        setIsBetting(false);
        return;
      }

      // Approve token spending first using sendTransactionSync (uses eth_sendRawTransactionSync if available)
      const approveReceipt = await walletClient.sendTransactionSync({
        account: wallet.address as `0x${string}`,
        chain: monadTestnet,
        to: MOCK_TOKEN_ADDRESS,
        data: encodeFunctionData({
          abi: tokenABI,
          functionName: 'approve',
          args: [CRASH_GAME_ADDRESS, betAmountWei],
        }),
        timeout: 10000, // 10 second timeout
      });

      // Verify approve transaction succeeded
      if (approveReceipt.status !== 'success') {
        throw new Error('Approve transaction failed');
      }

      // Wait a bit to ensure the approve transaction is fully processed
      await new Promise(resolve => setTimeout(resolve, 500));

      // Place bet using sendTransactionSync (uses eth_sendRawTransactionSync if available)
      const betReceipt = await walletClient.sendTransactionSync({
        account: wallet.address as `0x${string}`,
        chain: monadTestnet,
        to: CRASH_GAME_ADDRESS,
        data: encodeFunctionData({
          abi: crashGameABI,
          functionName: 'placeBet',
          args: [BigInt(roundId), betAmountWei],
        }),
        timeout: 10000, // 10 second timeout
      });

      // Verify bet transaction succeeded
      if (betReceipt.status !== 'success') {
        throw new Error('Bet transaction failed');
      }

      setHasBet(true);
      setCashOutMultiplier(null);

      // Add player to the list
      setPlayers((prev) => {
        const existingPlayerIndex = prev.findIndex(p => p.id === walletAddress);
        if (existingPlayerIndex !== -1) {
          const updatedPlayers = [...prev];
          updatedPlayers[existingPlayerIndex] = {
            ...updatedPlayers[existingPlayerIndex],
            bet: betAmountNum,
            status: 'pending' as const,
            cashOut: undefined,
            payout: undefined,
          };
          return updatedPlayers;
        }
        return [
          ...prev,
          {
            id: walletAddress,
            name: formatAddress(walletAddress),
            bet: betAmountNum,
            status: 'pending' as const,
          },
        ];
      });
    } catch (err) {
      console.error('Error joining game:', err);
      // Don't show error to user
    } finally {
      setIsBetting(false);
    }
  };

  const handleClaimProfits = async () => {
    if (!wallets[0]?.address || !CRASH_GAME_ADDRESS || isClaiming) {
      return;
    }

    if (parseFloat(claimablePayouts) <= 0) {
      return;
    }

    setIsClaiming(true);

    try {
      const wallet = wallets[0];
      const provider = await wallet.getEthereumProvider();

      // Check current chain and switch if needed
      try {
        const currentChainId = await provider.request({ method: 'eth_chainId' });
        const currentChainIdNumber = parseInt(currentChainId as string, 16);

        if (currentChainIdNumber !== MONAD_TESTNET_CHAIN.id) {
          // Try to switch to Monad Testnet
          try {
            await provider.request({
              method: 'wallet_switchEthereumChain',
              params: [{ chainId: `0x${MONAD_TESTNET_CHAIN.id.toString(16)}` }],
            });
          } catch (switchError: unknown) {
            // If the chain doesn't exist in the wallet, add it
            if (switchError && typeof switchError === 'object' && 'code' in switchError && switchError.code === 4902) {
              await provider.request({
                method: 'wallet_addEthereumChain',
                params: [
                  {
                    chainId: `0x${MONAD_TESTNET_CHAIN.id.toString(16)}`,
                    chainName: MONAD_TESTNET_CHAIN.name,
                    nativeCurrency: MONAD_TESTNET_CHAIN.nativeCurrency,
                    rpcUrls: MONAD_TESTNET_CHAIN.rpcUrls.default.http,
                    blockExplorerUrls: [MONAD_TESTNET_CHAIN.blockExplorers.default.url],
                  },
                ],
              });
            } else {
              throw switchError;
            }
          }

          // Wait a bit for the chain switch to complete
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch (chainError) {
        console.error('Error switching chain:', chainError);
        setIsClaiming(false);
        return;
      }

      const walletClient = createWalletClient({
        account: wallet.address as `0x${string}`,
        chain: monadTestnet,
        transport: custom(provider),
      });

      const publicClient = createPublicClient({
        chain: monadTestnet,
        transport: http(),
      });

      // Claim all payouts using sendTransactionSync (uses eth_sendRawTransactionSync if available)
      const claimReceipt = await walletClient.sendTransactionSync({
        account: wallet.address as `0x${string}`,
        chain: monadTestnet,
        to: CRASH_GAME_ADDRESS,
        data: encodeFunctionData({
          abi: crashGameABI,
          functionName: 'claimAllPayouts',
          args: [],
        }),
        timeout: 10000, // 10 second timeout
      });

      // Verify claim transaction succeeded
      if (claimReceipt.status !== 'success') {
        throw new Error('Claim transaction failed');
      }

      // Refresh claimable payouts
      const payouts = await publicClient.readContract({
        address: CRASH_GAME_ADDRESS,
        abi: crashGameABI,
        functionName: 'claimablePayouts',
        args: [wallet.address as `0x${string}`],
      });

      const decimals = await publicClient.readContract({
        address: MOCK_TOKEN_ADDRESS,
        abi: tokenABI,
        functionName: 'decimals',
      });

      const formattedPayouts = formatUnits(payouts as bigint, decimals as number);
      setClaimablePayouts(parseFloat(formattedPayouts).toFixed(2));
    } catch (err) {
      console.error('Error claiming profits:', err);
      // Don't show error to user
    } finally {
      setIsClaiming(false);
    }
  };

  const handleCashOut = () => {
    if (gameState !== 2 || !hasBet || !roundId) return;
    const walletAddress = wallets[0]?.address;
    if (!walletAddress) return;

    const multiplier = currentMultiplier;

    // Send cash-out request to server via WebSocket
    const success = sendMessage({
      type: 'cash_out',
      roundId: roundId,
      multiplier: multiplier,
      walletAddress: walletAddress,
    });

    if (!success) {
      setStatus('Failed to send cash-out request. Please try again.');
      return;
    }

    // Optimistically update UI
    setCashOutMultiplier(multiplier);
    setHasBet(false);
    setStatus(`Requesting cash-out at ${multiplier.toFixed(2)}x...`);

    // Update player in the list with cash out info (will be confirmed by server response)
    // Calculate payout with house edge (1.5%)
    const HOUSE_EDGE = 0.015;
    const betAmountNum = parseFloat(betAmount);
    const payoutBeforeFee = betAmountNum * multiplier;
    const payoutAmount = payoutBeforeFee * (1 - HOUSE_EDGE);
    setPlayers((prev) =>
      prev.map((p) =>
        p.id === walletAddress
          ? {
            ...p,
            cashOut: multiplier,
            payout: payoutAmount,
            status: 'cashed_out' as const,
          }
          : p
      )
    );
  };




  // Countdown timer effect
  useEffect(() => {
    if (countdownType === 'betting' && bettingCloseTime) {
      const interval = setInterval(() => {
        const now = Math.floor(Date.now() / 1000);
        const remaining = Math.max(0, bettingCloseTime - now);
        setCountdown(remaining);

        if (remaining <= 0) {
          setCountdown(null);
          setCountdownType(null);
          clearInterval(interval);
        }
      }, 100);

      return () => clearInterval(interval);
    } else if (countdownType === 'prepared' && countdown !== null) {
      const interval = setInterval(() => {
        setCountdown((prev) => {
          if (prev === null || prev <= 1) {
            setCountdownType(null);
            return null;
          }
          return prev - 1;
        });
      }, 1000);

      return () => clearInterval(interval);
    }
  }, [countdownType, bettingCloseTime, countdown]);

  // Fetch wallet token balance
  useEffect(() => {
    const fetchWalletBalance = async () => {
      if (!wallets[0]?.address || !MOCK_TOKEN_ADDRESS) {
        setTokenBalance('0.00');
        return;
      }

      try {
        const publicClient = createPublicClient({
          chain: monadTestnet,
          transport: http(),
        });

        const balance = await publicClient.readContract({
          address: MOCK_TOKEN_ADDRESS,
          abi: tokenABI,
          functionName: 'balanceOf',
          args: [wallets[0].address as `0x${string}`],
        });

        const decimals = await publicClient.readContract({
          address: MOCK_TOKEN_ADDRESS,
          abi: tokenABI,
          functionName: 'decimals',
        });

        const formattedBalance = formatUnits(balance as bigint, decimals as number);
        setTokenBalance(parseFloat(formattedBalance).toFixed(2));
      } catch (err) {
        console.error('Error fetching wallet balance:', err);
        setTokenBalance('0.00');
      }
    };

    fetchWalletBalance();
    // Refresh balance every 5 seconds
    const interval = setInterval(fetchWalletBalance, 5000);
    return () => clearInterval(interval);
  }, [wallets, MOCK_TOKEN_ADDRESS, tokenABI]);

  // Fetch claimable payouts
  useEffect(() => {
    const fetchClaimablePayouts = async () => {
      if (!wallets[0]?.address || !CRASH_GAME_ADDRESS) {
        setClaimablePayouts('0.00');
        return;
      }

      try {
        const publicClient = createPublicClient({
          chain: monadTestnet,
          transport: http(),
        });

        const payouts = await publicClient.readContract({
          address: CRASH_GAME_ADDRESS,
          abi: crashGameABI,
          functionName: 'claimablePayouts',
          args: [wallets[0].address as `0x${string}`],
        });

        const decimals = await publicClient.readContract({
          address: MOCK_TOKEN_ADDRESS,
          abi: tokenABI,
          functionName: 'decimals',
        });

        const formattedPayouts = formatUnits(payouts as bigint, decimals as number);
        setClaimablePayouts(parseFloat(formattedPayouts).toFixed(2));
      } catch (err) {
        console.error('Error fetching claimable payouts:', err);
        setClaimablePayouts('0.00');
      }
    };

    fetchClaimablePayouts();
    // Refresh payouts every 5 seconds
    const interval = setInterval(fetchClaimablePayouts, 5000);
    return () => clearInterval(interval);
  }, [wallets, CRASH_GAME_ADDRESS, MOCK_TOKEN_ADDRESS, crashGameABI, tokenABI]);

  return (
    <div className="h-screen relative overflow-x-hidden flex flex-col" style={{ backgroundColor: '#000000', color: '#F1F5F9' }}>
      <div className="w-full h-full pt-2 md:pt-3 overflow-x-hidden flex flex-col relative z-10" style={{ paddingLeft: '24px', paddingRight: '24px', paddingBottom: '32px', maxWidth: '1920px', margin: '0 auto' }}>
        <div className="mb-4 mt-2 p-3 glass neon-border flex flex-col md:flex-row items-center justify-center gap-4 md:gap-8" style={{
          backgroundColor: 'rgba(184, 167, 255, 0.05)',
          borderColor: 'rgba(184, 167, 255, 0.3)',
          borderRadius: '2px'
        }}>
          <div className="flex items-center gap-3">
            <div className="w-2.5 h-2.5 rounded-full animate-pulse" style={{ backgroundColor: '#B8A7FF' }}></div>
            <span className="font-bold text-sm md:text-base uppercase tracking-widest text-[#B8A7FF]">
              Notice: If game is not running, please fund the server address with testnet MON to resume the loop:
            </span>
          </div>
          <div className="flex items-center gap-3 bg-black/40 px-4 py-2 rounded border border-[#B8A7FF]/20">
            <span className="font-mono text-base md:text-lg font-bold text-[#F1F5F9] opacity-90 select-all">0xA6800E23f1553913A63488e56229073907C722a7</span>
            <button
              onClick={() => {
                navigator.clipboard.writeText('0xA6800E23f1553913A63488e56229073907C722a7');
              }}
              className="text-[#B8A7FF] hover:text-white transition-all transform hover:scale-125"
              title="Copy Address"
            >
              <FaCopy size={18} />
            </button>
          </div>
        </div>

        {/* Header */}
        <div className="mb-3 p-6 md:p-8">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between mb-3 gap-2">
            <h1 className="text-4xl md:text-6xl lg:text-7xl font-black uppercase tracking-wider" style={{
              fontFamily: 'system-ui, sans-serif',
              color: '#F1F5F9',
              letterSpacing: '0.1em'
            }}>
              JUST RISK IT
            </h1>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2 md:gap-4 text-sm md:text-base font-light flex-wrap">
                {roundId && (
                  <span style={{ color: '#F1F5F9' }}>ROUND #{roundId}</span>
                )}
              </div>
              <div className="flex items-center gap-8">
                <a
                  href="https://github.com/Vinhhjk/just-risk-it"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:opacity-70 transition-opacity"
                  style={{ color: '#F1F5F9' }}
                >
                  <FaGithub size={32} />
                </a>
                <ClaimTokenButton />
                <ConnectWalletButton />
              </div>
            </div>
          </div>

          {/* Recent Multipliers and Hash */}
          {gameState === 3 && (
            <div className="flex items-center gap-4 text-sm font-light" style={{ color: '#F1F5F9' }}>
              <span>Crashed at <span style={{ color: '#B8A7FF' }}>{currentMultiplier.toFixed(2)}x</span></span>
            </div>
          )}

          <div className="flex items-center gap-4 mt-2">
            <p className="font-light text-sm uppercase" style={{ color: '#F1F5F9' }}>Recent results</p>
            {recentRounds.length > 0 && (
              <div className="flex items-center gap-2">
                {[...recentRounds].reverse().map((round, index) => {
                  let color = '#F1F5F9'; // white (below 2x)
                  if (round.multiplier >= 5) {
                    color = '#FCD34D'; // yellow (above 5x)
                  } else if (round.multiplier >= 2) {
                    color = '#10b981'; // green (above 2x)
                  }
                  return (
                    <a
                      key={`${round.roundId}-${index}`}
                      href={`/verify-game?roundid=${round.roundId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-light text-sm hover:underline cursor-pointer"
                      style={{ color }}
                    >
                      {round.multiplier.toFixed(2)}x
                    </a>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Desktop Layout */}
        <div className="hidden lg:grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4 flex-1" style={{ minHeight: 0 }}>
          {/* Left Side: A (Chart + Bet) and C (Chat) */}
          <div className="flex flex-col" style={{ height: '100%', overflow: 'hidden' }}>
            {/* A: Chart + Betting (side by side) */}
            <div className="grid grid-cols-1 md:grid-cols-[2fr_1fr] gap-4" style={{ flex: '1 1 0', minHeight: 0, overflow: 'hidden' }}>
              {/* Chart */}
              <div
                className="relative overflow-hidden glass neon-border"
                style={{
                  height: '100%',
                  minHeight: '400px',
                  borderRadius: '2px'
                }}
              >
                {/* Multiplier Overlay */}
                <div className="absolute top-4 left-4 z-10 glass neon-border px-6 py-3" style={{ borderRadius: '2px', minWidth: '140px' }}>
                  <div
                    className="text-6xl md:text-7xl font-black uppercase tracking-wider leading-none"
                    style={{
                      color: gameState === 3 ? '#ef4444' : gameState === 2 ? '#10b981' : '#F1F5F9',
                      fontFamily: 'system-ui, sans-serif'
                    }}
                  >
                    {currentMultiplier.toFixed(2)}x
                  </div>
                </div>

                {/* Game Status Overlay */}
                {gameState !== 2 && (
                  <div className="absolute inset-0 flex items-center justify-center z-10">
                    <div className="glass neon-border px-8 py-4" style={{ borderRadius: '2px' }}>
                      <div className="text-2xl font-black uppercase tracking-wider" style={{ color: '#B8A7FF' }}>
                        {(gameState === 1 || countdownType === 'prepared') && countdown !== null
                          ? (countdownType === 'betting'
                            ? `BETS CLOSING IN ${countdown} SEC`
                            : countdownType === 'prepared'
                              ? `STARTING IN ${countdown} SEC`
                              : '')
                          : status}
                      </div>
                    </div>
                  </div>
                )}

                <CrashGameChart
                  data={chartData}
                  currentMultiplier={currentMultiplier}
                  gameState={gameState}
                  status={status}
                />
              </div>

              {/* Betting Panel */}
              <div className="flex flex-col">
                <div className="glass neon-border p-4 md:p-6 flex-1" style={{ display: 'flex', flexDirection: 'column', minHeight: '400px', borderRadius: '2px' }}>
                  <h2 className="text-3xl font-black mb-6 uppercase tracking-wider" style={{ color: '#F1F5F9', letterSpacing: '0.05em' }}>Place Your Bets</h2>

                  <div className="space-y-4">
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="block font-light text-sm" style={{ color: '#F1F5F9' }}>Bet Amount (Max: 1000 mCHOG)</label>
                        {wallets[0]?.address && (
                          <span className="font-light text-sm" style={{ color: '#B8A7FF' }}>
                            {tokenBalance} mCHOG
                          </span>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <input
                          type="number"
                          step="0.01"
                          min="0.01"
                          max="1000"
                          value={betAmount}
                          onChange={(e) => {
                            const val = e.target.value;
                            const num = parseFloat(val);
                            if (val === '' || (!isNaN(num) && num >= 0.01 && num <= 1000)) {
                              setBetAmount(val);
                            }
                          }}
                          className="flex-1 px-3 py-2 font-light text-sm focus:outline-none glass neon-border"
                          style={{
                            backgroundColor: 'rgba(0, 0, 0, 0.4)',
                            color: '#F1F5F9',
                            borderRadius: '2px'
                          }}
                          disabled={hasBet || isBetting || !isBettingOpen}
                        />
                        <button
                          onClick={() => {
                            const current = parseFloat(betAmount) || 0;
                            const newValue = Math.max(0.01, current - 1);
                            setBetAmount(newValue.toFixed(2));
                          }}
                          disabled={hasBet || isBetting || !isBettingOpen}
                          className="glass neon-border font-black uppercase text-base transition-all hover:bg-opacity-60 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                          style={{ color: '#B8A7FF', borderRadius: '0px', width: '36px', height: '36px' }}
                        >
                          -
                        </button>
                        <button
                          onClick={() => {
                            const current = parseFloat(betAmount) || 0;
                            const newValue = Math.min(1000, current + 1);
                            setBetAmount(newValue.toFixed(2));
                          }}
                          disabled={hasBet || isBetting || !isBettingOpen}
                          className="glass neon-border font-black uppercase text-base transition-all hover:bg-opacity-60 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                          style={{ color: '#B8A7FF', borderRadius: '0px', width: '36px', height: '36px' }}
                        >
                          +
                        </button>
                      </div>
                    </div>

                    {/* Quick Bet Buttons */}
                    <div className="grid grid-cols-2 gap-2">
                      {['0.01', '0.05', '0.10', '0.25'].map((amount) => (
                        <button
                          key={amount}
                          onClick={() => setBetAmount(amount)}
                          className="px-3 py-2 font-light text-sm transition-all glass neon-border hover:bg-opacity-60"
                          style={{
                            color: '#B8A7FF',
                            borderRadius: '2px'
                          }}
                          disabled={hasBet || isBetting || !isBettingOpen}
                        >
                          {amount} mCHOG
                        </button>
                      ))}
                    </div>

                    <div className="space-y-3">
                      <button
                        onClick={(e) => {
                          if (!isBettingOpen) {
                            e.preventDefault();
                            e.stopPropagation();
                            return;
                          }
                          handleBet();
                        }}
                        disabled={hasBet || parseFloat(betAmount) <= 0 || isBetting || !isBettingOpen}
                        className="w-full py-4 font-black uppercase text-lg disabled:opacity-50 disabled:cursor-not-allowed transition-all neon-border"
                        style={{
                          backgroundColor: hasBet ? 'rgba(184, 167, 255, 0.2)' : 'rgba(184, 167, 255, 0.3)',
                          color: '#B8A7FF',
                          borderRadius: '2px',
                          opacity: !isBettingOpen ? 0.3 : 1,
                          pointerEvents: !isBettingOpen ? 'none' : 'auto'
                        }}
                      >
                        {isBetting ? 'Processing...' : hasBet ? 'Bet Placed' : 'Join Game'}
                      </button>

                      {/* Cash Out Button - Only show when game is running and player has bet */}
                      {gameState === 2 && hasBet && (
                        <button
                          onClick={handleCashOut}
                          disabled={!hasBet || !roundId}
                          className="w-full py-4 font-black uppercase text-lg disabled:opacity-50 disabled:cursor-not-allowed transition-all neon-border"
                          style={{
                            backgroundColor: '#10b981',
                            color: '#000000',
                            borderRadius: '2px'
                          }}
                        >
                          Cash out {((parseFloat(betAmount) * currentMultiplier) * 0.985).toFixed(2)} mCHOG
                        </button>
                      )}

                      <div>
                        <button
                          onClick={handleClaimProfits}
                          disabled={isClaiming || parseFloat(claimablePayouts) <= 0}
                          className="w-full py-3 font-black uppercase text-sm disabled:opacity-50 disabled:cursor-not-allowed transition-all neon-border"
                          style={{
                            backgroundColor: '#B8A7FF',
                            color: '#000000',
                            borderRadius: '2px'
                          }}
                        >
                          {isClaiming ? 'Claiming...' : 'Claim Profits'}
                        </button>
                        {wallets[0]?.address && (
                          <div className="text-xs font-light mt-1 text-center" style={{ color: 'rgba(241, 245, 249, 0.7)' }}>
                            {claimablePayouts} mCHOG available
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Verifiably Fair Button - Disconnected, positioned near bottom */}
                  <div className="mt-10 flex justify-start">
                    <a
                      href="/verify-game"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block font-black uppercase text-xs text-center transition-all"
                      style={{
                        backgroundColor: '#B8A7FF',
                        color: '#000000',
                        borderRadius: '8px',
                        textDecoration: 'none',
                        border: '3px solid #000000',
                        boxShadow: '4px 4px 0px 0px #000000',
                        transform: 'translate(0, 0)',
                        width: '140px',
                        height: '40px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                      onMouseDown={(e) => {
                        e.currentTarget.style.transform = 'translate(2px, 2px)';
                        e.currentTarget.style.boxShadow = '2px 2px 0px 0px #000000';
                      }}
                      onMouseUp={(e) => {
                        e.currentTarget.style.transform = 'translate(0, 0)';
                        e.currentTarget.style.boxShadow = '4px 4px 0px 0px #000000';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.transform = 'translate(0, 0)';
                        e.currentTarget.style.boxShadow = '4px 4px 0px 0px #000000';
                      }}
                    >
                      Verifiably Fair!
                    </a>
                  </div>
                  {gameState === 2 && !hasBet && (
                    <div className="text-center py-8 flex-1 flex items-center justify-center">
                      <div>
                        <p className="font-light uppercase" style={{ color: '#F1F5F9' }}>Game is running</p>
                        <p className="text-sm mt-2 font-light" style={{ color: 'rgba(241, 245, 249, 0.7)' }}>Wait for next round to bet</p>
                      </div>
                    </div>
                  )}

                  {gameState === 3 && (
                    <div className="text-center py-8 flex-1 flex items-center justify-center">
                      <div>
                        <p className="font-light uppercase" style={{ color: '#F1F5F9' }}>Game ended</p>
                        <p className="text-sm mt-2 font-light" style={{ color: 'rgba(241, 245, 249, 0.7)' }}>Wait for next round</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* C: Chat Section (same width as A) */}
            <div className="shrink-0" style={{ marginTop: '24px', height: '200px', display: 'flex', flexDirection: 'column' }}>
              <Chat
                messages={chatMessages}
                onSendMessage={(message) => {
                  const walletAddress = wallets[0]?.address;
                  if (walletAddress && sendMessage) {
                    sendMessage({
                      type: 'chat_message',
                      address: walletAddress,
                      message: message
                    });
                  }
                }}
              />
            </div>
          </div>

          {/* Right Side: B (Players List - Full Height) */}
          <div className="hidden lg:block" style={{ height: '100%' }}>
            <PlayerList
              players={players}
              totalBetting={players.reduce((sum, p) => sum + p.bet, 0)}
              playerCount={players.length}
              watchingCount={50}
              roundId={roundId}
            />
          </div>
        </div>

        {/* Mobile Layout */}
        <div className="lg:hidden flex flex-col flex-1" style={{ minHeight: 0, overflow: 'hidden', paddingBottom: '80px' }}>
          {/* Chart - Always visible on mobile */}
          <div
            className="relative overflow-hidden glass neon-border mb-4"
            style={{
              height: '300px',
              borderRadius: '2px'
            }}
          >
            {/* Multiplier Overlay */}
            <div className="absolute top-4 left-4 z-10 glass neon-border px-4 py-2" style={{ borderRadius: '2px', minWidth: '120px' }}>
              <div
                className="text-4xl font-black uppercase tracking-wider leading-none"
                style={{
                  color: gameState === 3 ? '#ef4444' : gameState === 2 ? '#10b981' : '#F1F5F9',
                  fontFamily: 'system-ui, sans-serif'
                }}
              >
                {currentMultiplier.toFixed(2)}x
              </div>
            </div>

            {/* Game Status Overlay */}
            {gameState !== 2 && (
              <div className="absolute inset-0 flex items-center justify-center z-10">
                <div className="glass neon-border px-6 py-3" style={{ borderRadius: '2px' }}>
                  <div className="text-lg font-black uppercase tracking-wider" style={{ color: '#B8A7FF' }}>
                    {(gameState === 1 || countdownType === 'prepared') && countdown !== null
                      ? (countdownType === 'betting'
                        ? `BETS CLOSING IN ${countdown} SEC`
                        : countdownType === 'prepared'
                          ? `STARTING IN ${countdown} SEC`
                          : '')
                      : status}
                  </div>
                </div>
              </div>
            )}

            <CrashGameChart
              data={chartData}
              currentMultiplier={currentMultiplier}
              gameState={gameState}
            />
          </div>

          {/* Mobile Content Area - Switchable Views */}
          <div className="flex-1 overflow-y-auto" style={{ minHeight: 0 }}>
            {/* Players View (Default) */}
            {mobileView === 'players' && (
              <div className="mb-4">
                <PlayerList
                  players={players}
                  totalBetting={players.reduce((sum, p) => sum + p.bet, 0)}
                  playerCount={players.length}
                  watchingCount={50}
                  roundId={roundId}
                />
                {/* Bet Button - Opens betting panel */}
                {isBettingOpen && (
                  <button
                    onClick={() => setMobileView('betting')}
                    className="w-full mt-4 py-4 font-black uppercase text-lg transition-all neon-border"
                    style={{
                      backgroundColor: 'rgba(184, 167, 255, 0.3)',
                      color: '#B8A7FF',
                      borderRadius: '2px'
                    }}
                  >
                    Place Bet
                  </button>
                )}
              </div>
            )}

            {/* Betting View */}
            {mobileView === 'betting' && (
              <div className="glass neon-border p-4 mb-4" style={{ borderRadius: '2px' }}>
                <h2 className="text-2xl font-black mb-4 uppercase tracking-wider" style={{ color: '#F1F5F9', letterSpacing: '0.05em' }}>Place Your Bets</h2>

                <div className="space-y-4">
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="block font-light uppercase text-sm" style={{ color: '#F1F5F9' }}>Bet Amount (Max: 1000 mCHOG)</label>
                      {wallets[0]?.address && (
                        <span className="font-light text-sm" style={{ color: '#B8A7FF' }}>
                          {tokenBalance} mCHOG
                        </span>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <input
                        type="number"
                        step="0.01"
                        min="0.01"
                        max="1000"
                        value={betAmount}
                        onChange={(e) => {
                          const val = e.target.value;
                          const num = parseFloat(val);
                          if (val === '' || (!isNaN(num) && num >= 0.01 && num <= 1000)) {
                            setBetAmount(val);
                          }
                        }}
                        className="flex-1 px-3 py-2 font-light text-sm focus:outline-none glass neon-border"
                        style={{
                          backgroundColor: 'rgba(0, 0, 0, 0.4)',
                          color: '#F1F5F9',
                          borderRadius: '2px'
                        }}
                        disabled={hasBet || isBetting || !isBettingOpen}
                      />
                      <button
                        onClick={() => {
                          const current = parseFloat(betAmount) || 0;
                          const newValue = Math.max(0.01, current - 1);
                          setBetAmount(newValue.toFixed(2));
                        }}
                        disabled={hasBet || isBetting || !isBettingOpen}
                        className="glass neon-border font-black uppercase text-base transition-all hover:bg-opacity-60 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                        style={{ color: '#B8A7FF', borderRadius: '0px', width: '36px', height: '36px' }}
                      >
                        -
                      </button>
                      <button
                        onClick={() => {
                          const current = parseFloat(betAmount) || 0;
                          const newValue = Math.min(1000, current + 1);
                          setBetAmount(newValue.toFixed(2));
                        }}
                        disabled={hasBet || isBetting || !isBettingOpen}
                        className="glass neon-border font-black uppercase text-base transition-all hover:bg-opacity-60 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                        style={{ color: '#B8A7FF', borderRadius: '0px', width: '36px', height: '36px' }}
                      >
                        +
                      </button>
                    </div>
                  </div>

                  {/* Quick Bet Buttons */}
                  <div className="grid grid-cols-2 gap-2">
                    {['0.01', '0.05', '0.10', '0.25'].map((amount) => (
                      <button
                        key={amount}
                        onClick={() => setBetAmount(amount)}
                        className="px-3 py-2 font-light text-sm transition-all glass neon-border hover:bg-opacity-60"
                        style={{
                          color: '#B8A7FF',
                          borderRadius: '2px'
                        }}
                        disabled={hasBet || isBetting || !isBettingOpen}
                      >
                        {amount} mCHOG
                      </button>
                    ))}
                  </div>

                  <div className="space-y-3">
                    <button
                      onClick={(e) => {
                        if (!isBettingOpen) {
                          e.preventDefault();
                          e.stopPropagation();
                          return;
                        }
                        handleBet();
                      }}
                      disabled={hasBet || parseFloat(betAmount) <= 0 || isBetting || !isBettingOpen}
                      className="w-full py-4 font-black uppercase text-lg disabled:opacity-50 disabled:cursor-not-allowed transition-all neon-border"
                      style={{
                        backgroundColor: hasBet ? 'rgba(184, 167, 255, 0.2)' : 'rgba(184, 167, 255, 0.3)',
                        color: '#B8A7FF',
                        borderRadius: '2px',
                        opacity: !isBettingOpen ? 0.3 : 1,
                        pointerEvents: !isBettingOpen ? 'none' : 'auto'
                      }}
                    >
                      {isBetting ? 'Processing...' : hasBet ? 'Bet Placed' : 'Join Game'}
                    </button>

                    {/* Cash Out Button - Only show when game is running and player has bet */}
                    {gameState === 2 && hasBet && (
                      <button
                        onClick={handleCashOut}
                        disabled={!hasBet || !roundId}
                        className="w-full py-4 font-black uppercase text-lg disabled:opacity-50 disabled:cursor-not-allowed transition-all neon-border"
                        style={{
                          backgroundColor: '#10b981',
                          color: '#000000',
                          borderRadius: '2px'
                        }}
                      >
                        Cash out {((parseFloat(betAmount) * currentMultiplier) * 0.985).toFixed(2)} mCHOG
                      </button>
                    )}

                    <div>
                      <button
                        onClick={handleClaimProfits}
                        disabled={isClaiming || parseFloat(claimablePayouts) <= 0}
                        className="w-full py-3 font-black uppercase text-sm disabled:opacity-50 disabled:cursor-not-allowed transition-all neon-border"
                        style={{
                          backgroundColor: '#B8A7FF',
                          color: '#000000',
                          borderRadius: '2px'
                        }}
                      >
                        {isClaiming ? 'Claiming...' : 'Claim Profits'}
                      </button>
                      {wallets[0]?.address && (
                        <div className="text-xs font-light mt-1 text-center" style={{ color: 'rgba(241, 245, 249, 0.7)' }}>
                          {claimablePayouts} mCHOG available
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Verifiably Fair Button - Disconnected, positioned independently */}
                <div className="mt-10 flex justify-start">
                  <a
                    href="/verify-game"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block font-black uppercase text-xs text-center transition-all"
                    style={{
                      backgroundColor: '#B8A7FF',
                      color: '#000000',
                      borderRadius: '8px',
                      textDecoration: 'none',
                      border: '3px solid #000000',
                      boxShadow: '4px 4px 0px 0px #000000',
                      transform: 'translate(0, 0)',
                      width: '140px',
                      height: '40px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                    onMouseDown={(e) => {
                      e.currentTarget.style.transform = 'translate(2px, 2px)';
                      e.currentTarget.style.boxShadow = '2px 2px 0px 0px #000000';
                    }}
                    onMouseUp={(e) => {
                      e.currentTarget.style.transform = 'translate(0, 0)';
                      e.currentTarget.style.boxShadow = '4px 4px 0px 0px #000000';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.transform = 'translate(0, 0)';
                      e.currentTarget.style.boxShadow = '4px 4px 0px 0px #000000';
                    }}
                  >
                    Verifiably Fair!
                  </a>
                </div>

                {gameState === 2 && hasBet && (
                  <div className="space-y-4 mt-4">
                    <button
                      onClick={handleCashOut}
                      className="w-full py-4 font-black uppercase text-lg transition-all neon-border"
                      style={{
                        backgroundColor: 'rgba(16, 185, 129, 0.2)',
                        color: '#10b981',
                        borderRadius: '2px'
                      }}
                    >
                      Cash Out
                    </button>
                  </div>
                )}

                {gameState === 2 && !hasBet && (
                  <div className="text-center py-8">
                    <div>
                      <p className="font-light uppercase" style={{ color: '#F1F5F9' }}>Game is running</p>
                      <p className="text-sm mt-2 font-light" style={{ color: 'rgba(241, 245, 249, 0.7)' }}>Wait for next round to bet</p>
                    </div>
                  </div>
                )}

                {gameState === 3 && (
                  <div className="text-center py-8">
                    <div>
                      <p className="font-light uppercase" style={{ color: '#F1F5F9' }}>Game ended</p>
                      <p className="text-sm mt-2 font-light" style={{ color: 'rgba(241, 245, 249, 0.7)' }}>Wait for next round</p>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Chat View */}
            {mobileView === 'chat' && (
              <div className="mb-4" style={{ height: '400px', display: 'flex', flexDirection: 'column' }}>
                <Chat
                  messages={chatMessages}
                  onSendMessage={(message) => {
                    const walletAddress = wallets[0]?.address;
                    if (walletAddress && sendMessage) {
                      sendMessage({
                        type: 'chat_message',
                        address: walletAddress,
                        message: message
                      });
                    }
                  }}
                />
              </div>
            )}
          </div>

          {/* Bottom Navigation Bar - Mobile Only */}
          <div className="fixed bottom-0 left-0 right-0 lg:hidden glass neon-border" style={{
            borderTop: '1px solid rgba(184, 167, 255, 0.6)',
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            backdropFilter: 'blur(12px)',
            zIndex: 100
          }}>
            <div className="flex items-center justify-around py-3">
              <button
                onClick={() => setMobileView('players')}
                className="flex flex-col items-center gap-1 px-4 py-2 transition-all"
                style={{
                  color: mobileView === 'players' ? '#B8A7FF' : 'rgba(184, 167, 255, 0.5)',
                }}
              >
                <GrGroup size={24} />
                <span className="text-xs font-light uppercase">Players</span>
              </button>
              <button
                onClick={() => setMobileView('betting')}
                className="flex flex-col items-center gap-1 px-4 py-2 transition-all"
                style={{
                  color: mobileView === 'betting' ? '#B8A7FF' : 'rgba(184, 167, 255, 0.5)',
                }}
              >
                <FaDice size={24} />
                <span className="text-xs font-light uppercase">Play</span>
              </button>
              <button
                onClick={() => setMobileView('chat')}
                className="flex flex-col items-center gap-1 px-4 py-2 transition-all"
                style={{
                  color: mobileView === 'chat' ? '#B8A7FF' : 'rgba(184, 167, 255, 0.5)',
                }}
              >
                <IoChatbubbleOutline size={24} />
                <span className="text-xs font-light uppercase">Chat</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

