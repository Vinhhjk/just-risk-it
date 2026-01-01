import { WebSocket } from 'ws';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../.env") });

interface GameUpdate {
  currentValue: number;
  bar: {
    open: number;
    high: number;
    low: number;
    close: number;
    time: {
      year: number;
      month: number;
      day: number;
    };
  };
  gameState: number;
  nextGameNoMoreBetsAt: number;
}

const WS_PORT = parseInt(process.env.WS_PORT || '6969');
const WS_URL = `ws://localhost:${WS_PORT}`;
const MAX_RETRIES = 30; // Retry for up to 30 attempts
const RETRY_DELAY_MS = 2000; // Wait 2 seconds between retries

let tickCount = 0;
let lastMultiplier = 1.00;
let gameStarted = false;
let ws: WebSocket | null = null;
let retryCount = 0;
let isConnected = false;

function connect(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (retryCount > 0) {
      console.log(`Retrying connection (attempt ${retryCount + 1}/${MAX_RETRIES})...`);
    } else {
      console.log(`\nCrash Game Client\n`);
      console.log(`Connecting to ${WS_URL}...\n`);
    }
    
    ws = new WebSocket(WS_URL);
    
    ws.on('open', () => {
      isConnected = true;
      retryCount = 0; // Reset retry count on successful connection
      console.log(`Connected to crash game server\n`);
      console.log(`Waiting for game updates...\n`);
      console.log(`${'='.repeat(60)}\n`);
      resolve();
    });
    
    ws.on('error', (error: Error) => {
      if (!isConnected) {
        // Connection failed, will retry
        reject(error);
      } else {
        // Error after connection (different handling)
        console.error(`\nWebSocket error: ${error.message}\n`);
      }
    });
    
    ws.on('message', async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        
        // Handle status messages
        if (message.type === 'status') {
          switch (message.status) {
            case 'preparing_game':
              console.log(`Status: ${message.message || 'Preparing game...'}\n`);
              break;
            case 'prepared':
              console.log(`\n${message.message || 'Game data prepared'}`);
              console.log(`   Round: ${message.roundId || 'N/A'}`);
              console.log(`   Waiting 5 seconds before game starts...\n`);
              // Wait 5 seconds (same as server)
              await new Promise(resolve => setTimeout(resolve, 5000));
              break;
            case 'game_started':
              console.log(`\nGAME STARTED! (Round ${message.roundId || 'N/A'})\n`);
              gameStarted = true;
              tickCount = 0; // Reset tick count for new game
              break;
            case 'revealed':
              console.log(`\nSERVER SEED REVEALED`);
              console.log(`   Round: ${message.roundId || 'N/A'}`);
              console.log(`   Server Seed: ${message.serverSeed || 'N/A'}`);
              console.log(`   TX: ${message.txHash || 'N/A'}`);
              console.log(`   [Game is now verifiable]`);
              console.log(`   [Waiting for next game...]\n`);
              // Reset for next game
              gameStarted = false;
              tickCount = 0;
              lastMultiplier = 1.00;
              break;
          }
          return;
        }
        
        // Handle game update messages
        if (message.type === 'update') {
          const update: GameUpdate = message;
          tickCount++;
          
          const multiplier = update.currentValue / 100000;
          const gameStateNames: Record<number, string> = {
            1: 'BETTING',
            2: 'RUNNING',
            3: 'CRASHED'
          };
          
          const gameStateName = gameStateNames[update.gameState] || 'UNKNOWN';
          
          // Show first few ticks and then every 10th tick, or if state changes
          const shouldShow = tickCount <= 5 || tickCount % 10 === 0 || 
                             update.gameState === 3;
          
          if (shouldShow || update.gameState === 3) {
            if (update.gameState === 3) {
              // Game crashed (this might be redundant if we got game_ended status, but keep for safety)
              console.log(`\n${'='.repeat(60)}`);
              console.log(`CRASHED at ${update.bar.high.toFixed(2)}x`);
              console.log(`   Tick: ${tickCount}`);
              console.log(`   Final Value: ${update.currentValue}`);
              console.log(`${'='.repeat(60)}\n`);
            } else {
              const change = multiplier > lastMultiplier ? '+' : multiplier < lastMultiplier ? '-' : '=';
              console.log(`Tick ${tickCount.toString().padStart(4)} | ${gameStateName.padEnd(8)} | ${change} ${multiplier.toFixed(2)}x | Value: ${update.currentValue}`);
            }
          }
          
          lastMultiplier = multiplier;
        }
      } catch (error: any) {
        console.error(`Error parsing message: ${error.message}`);
      }
    });
    
    ws.on('close', () => {
      if (isConnected) {
        console.log(`\nConnection closed.\n`);
        process.exit(0);
      }
    });
  });
}

async function connectWithRetry() {
  while (retryCount < MAX_RETRIES) {
    try {
      await connect();
      return; // Successfully connected
    } catch (error: any) {
      retryCount++;
      
      if (retryCount >= MAX_RETRIES) {
        console.error(`\nFailed to connect after ${MAX_RETRIES} attempts.`);
        console.error(`\nMake sure the crash game server is running:`);
        console.error(`   npm run crash-game\n`);
        process.exit(1);
      }
      
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}

// Start connection with retry
connectWithRetry().catch((error) => {
  console.error(`\nConnection error: ${error.message}`);
  process.exit(1);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log(`\n\nDisconnecting...\n`);
  if (ws) {
    ws.close();
  }
  process.exit(0);
});
