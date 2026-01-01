import { ethers } from "ethers";
import crypto from "crypto";

interface GameInput {
  roundId: number;
  vrfRandom: string;
  serverSeed: string;
  chainId: number;
  startTimestamp: string;
  tickIntervalMs: number;
}

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
  timestamp?: number; // Optional - will be added by server when sending (current server time)
  gameState: number;
  nextGameNoMoreBetsAt: number;
}

/**
 * Derive the combined seed from VRF + server seed
 * This is NEVER stored on-chain or exposed to frontend
 * Formula: keccak256(vrfRandom || roundId || serverSeed || chainId)
 */
function deriveSeed(vrfRandom: string, roundId: number, serverSeed: string, chainId: number): bigint {
  const vrfBytes = ethers.zeroPadValue(ethers.toBeHex(BigInt(vrfRandom)), 32);
  const roundBytes = ethers.zeroPadValue(ethers.toBeHex(BigInt(roundId)), 32);
  const seedBytes = ethers.toUtf8Bytes(serverSeed);
  const chainBytes = ethers.zeroPadValue(ethers.toBeHex(BigInt(chainId)), 32);
  
  const combined = ethers.concat([vrfBytes, roundBytes, seedBytes, chainBytes]);
  const hash = ethers.keccak256(combined);
  return BigInt(hash);
}

/**
 * Generate cryptographically secure server seed
 */
export function generateServerSeed(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Compute server seed hash for on-chain commitment
 */
export function computeServerSeedHash(serverSeed: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(serverSeed));
}

/**
 * Generate crash game from combined VRF + server seed
 * The derived seed is never exposed - only game ticks are streamed
 */
export interface CrashGameResult {
  updates: GameUpdate[];
  finalMultiplier: number;
  rawMultiplier: number; // Raw multiplier before rounding
}

export function generateCrashGame(input: GameInput): CrashGameResult {
  const { roundId, vrfRandom, serverSeed, chainId, startTimestamp, tickIntervalMs } = input;
  
  const derivedSeed = deriveSeed(vrfRandom, roundId, serverSeed, chainId);
  const startTime = parseInt(startTimestamp);
  // Store start time for relative timestamp calculation (not exposed to clients)
  const gameStartTimeAbsolute = startTime;
  
  function getRandom(i: number): number {
    const seedBytes = ethers.zeroPadValue(ethers.toBeHex(derivedSeed), 32);
    const indexBytes = ethers.zeroPadValue(ethers.toBeHex(BigInt(i)), 32);
    const combined = ethers.concat([seedBytes, indexBytes]);
    const hash = ethers.keccak256(combined);
    const hashBigInt = BigInt(hash);
    const maxUint256 = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
    return Number(hashBigInt) / Number(maxUint256);
  }
  
  const r0 = getRandom(0);
  const r1 = getRandom(1);
  
  const houseEdge = 0.015; // 1.5% house edge
  
  // Standard crash game formula (Bustabit/Stake style)
  // Formula: multiplier = (1 - houseEdge) / (1 - p)
  // Where p is uniformly distributed in [houseEdge, 1)
  // This allows for instant crashes when p = houseEdge
  
  // Map r0 (uniform in [0, 1)) to p (uniform in [houseEdge, 1))
  // This ensures p can be exactly houseEdge when r0 = 0, giving multiplier = 1.00x
  const p = houseEdge + r0 * (1 - houseEdge);
  
  // Calculate raw multiplier
  // When p = houseEdge (r0 = 0), multiplier = (1 - houseEdge) / (1 - houseEdge) = 1.00x (instant crash)
  // When p approaches 1 (r0 approaches 1), multiplier approaches infinity (clamped to 10000x)
  const rawMultiplier = (1 - houseEdge) / (1 - p);
  
  // Clamp to valid range [1.00, 10000]
  // IMPORTANT: We allow 1.00x (instant crash) - do NOT use Math.max(1.01, ...)
  const crashMultiplier = Math.max(1.00, Math.min(rawMultiplier, 10000));
  
  // Round to 2 decimal places (rounds down for values like 1.004 -> 1.00)
  // IMPORTANT: This can round 1.004x down to 1.00x, which is correct for instant crashes
  const finalMultiplier = Math.round(crashMultiplier * 100) / 100;
  
  // Derive trading parameters from VRF randomness (deterministic and verifiable)
  const r2 = getRandom(2); // For minPrice range
  const r3 = getRandom(3); // For trendStrength
  const r4 = getRandom(4); // For volatilityBase
  const r5 = getRandom(5); // For volatilityDecay
  
  // minPrice: Can range from 0.40x to 0.70x (allows 30-60% drawdowns)
  const minPrice = 0.40 + r2 * 0.30;
  
  // trendStrength: Range from 0.15 to 0.45 (weak to strong trend)
  const trendStrength = 0.15 + r3 * 0.30;
  
  // volatilityBase: Range from 0.015 to 0.035 (1.5% to 3.5% per tick)
  const volatilityBase = 0.015 + r4 * 0.020;
  
  // volatilityDecay: Range from 0.5 to 0.9 (how quickly volatility decreases)
  const volatilityDecay = 0.5 + r5 * 0.4;
  
  // Log the actual crash multiplier for verification (only for low multipliers)
  // This helps verify instant crashes are possible
  if (finalMultiplier <= 1.01) {
    console.log(`   INSTANT/NEAR-INSTANT CRASH: ${finalMultiplier}x (raw: ${crashMultiplier.toFixed(4)}, p: ${p.toFixed(6)}, r0: ${r0.toFixed(6)})`);
  }
  
  const baseDuration = 3000;
  const maxDuration = 30000;
  const duration = baseDuration + Math.floor(r1 * (maxDuration - baseDuration));
  const totalTicks = Math.ceil(duration / tickIntervalMs);
  
  const updates: GameUpdate[] = [];
  
  // BETTING phase is handled by server timing (20 seconds), not by generating ticks
  // We only generate RUNNING phase ticks (gameState = 2)
  const gameStartTime = startTime;
  const gameTicks = totalTicks;
  
  let previousMultiplier = 1.00;
  let currentPrice = 1.00; // Track current price for trading simulation
  
  // Trading simulation parameters (derived from VRF above)
  const maxPrice = finalMultiplier; // Maximum price (crash point)
  // minPrice, trendStrength, volatilityBase, volatilityDecay are already defined above
  
  for (let i = 0; i < gameTicks; i++) {
    const progress = i / gameTicks;
    
    // Get random values for this tick
    const r1 = getRandom(i + 10); // Random for direction/volatility
    const r2 = getRandom(i + 20); // Random for trend
    
    // Calculate target price (trends toward crash point)
    // As progress increases, target moves closer to finalMultiplier
    const targetPrice = 1.00 + (maxPrice - 1.00) * Math.pow(progress, 0.8);
    
    // Volatility decreases as we approach crash (more stable near end)
    const volatility = volatilityBase * Math.pow(1 - progress, volatilityDecay);
    
    // Random walk: price can move up or down
    // Direction bias: slightly biased toward target price
    const directionBias = (targetPrice - currentPrice) * trendStrength;
    const randomMove = (r1 - 0.5) * 2; // -1 to +1
    const priceChange = directionBias + (randomMove * volatility);
    
    // Update price (can go up or down)
    currentPrice = currentPrice * (1 + priceChange);
    
    // Clamp price to valid range [minPrice, maxPrice]
    currentPrice = Math.max(minPrice, Math.min(currentPrice, maxPrice));
    
    // Round to 2 decimal places
    const roundedMultiplier = Math.round(currentPrice * 100) / 100;
    
    // Calculate high/low for this tick (price can go up or down)
    const tickHigh = Math.max(previousMultiplier, roundedMultiplier);
    const tickLow = Math.min(previousMultiplier, roundedMultiplier);
    
    const tickTime = gameStartTime + (i * tickIntervalMs / 1000);
    const tickDate = new Date(tickTime * 1000);
    // Don't include timestamp in the update - server will add it when sending
    // This prevents revealing pre-calculated crash timing
    
    // Crash when we reach or exceed the final multiplier
    // Use the raw currentPrice (before rounding) to compare with finalMultiplier
    // This ensures we don't crash early due to rounding
    const isCrash = currentPrice >= finalMultiplier || i === gameTicks - 1;
    
    if (isCrash) {
      const crashDate = new Date(tickTime * 1000);
      // Use finalMultiplier (the calculated value) instead of roundedMultiplier
      // This ensures consistency with the formula calculation
      const finalValue = Math.floor(finalMultiplier * 100000);
      
      updates.push({
        currentValue: finalValue,
        bar: {
          open: previousMultiplier,
          high: Math.max(previousMultiplier, finalMultiplier),
          low: Math.min(previousMultiplier, finalMultiplier),
          close: finalMultiplier,
          time: {
            year: crashDate.getUTCFullYear(),
            month: crashDate.getUTCMonth() + 1,
            day: crashDate.getUTCDate()
          }
        },
        // timestamp will be added by server when sending (current server time)
        gameState: 3,
        nextGameNoMoreBetsAt: 0
      });
      
      break;
    }
    
    const currentValue = Math.floor(roundedMultiplier * 100000);
    
      updates.push({
        currentValue,
        bar: {
          open: previousMultiplier,
          high: tickHigh,
          low: tickLow,
          close: roundedMultiplier,
          time: {
            year: tickDate.getUTCFullYear(),
            month: tickDate.getUTCMonth() + 1,
            day: tickDate.getUTCDate()
          }
        },
        // timestamp will be added by server when sending (current server time)
        gameState: 2,
        nextGameNoMoreBetsAt: 0
      });
      
      previousMultiplier = roundedMultiplier;
  }
  
  return {
    updates,
    finalMultiplier,
    rawMultiplier
  };
}

