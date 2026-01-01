import { generateServerSeed, generateCrashGame } from './crash-game-backend.js';
import crypto from 'crypto';

/**
 * Test script to verify instant crashes (1.00x) are possible
 * Run: npm run test-instant-crash
 */

const NUM_ROUNDS = 1000;

interface CrashStats {
  instantCrashes: number; // Exactly 1.00x
  nearInstantCrashes: number; // 1.00x - 1.01x
  lowCrashes: number; // 1.00x - 2.00x
  minMultiplier: number;
  maxMultiplier: number;
  distribution: Map<number, number>; // Bucket counts [bucket, bucket+1) e.g., [1, 2) means 1.00x to 1.99x
}

function testInstantCrashes() {
  console.log(`\n🧪 Testing ${NUM_ROUNDS} rounds for instant crash capability...\n`);
  
  const stats: CrashStats = {
    instantCrashes: 0,
    nearInstantCrashes: 0,
    lowCrashes: 0,
    minMultiplier: Infinity,
    maxMultiplier: 0,
    distribution: new Map(),
  };
  
  for (let round = 1; round <= NUM_ROUNDS; round++) {
    const serverSeed = generateServerSeed();
    // Use cryptographically secure random to match real VRF (256-bit uniform distribution)
    const vrfRandom = BigInt('0x' + crypto.randomBytes(32).toString('hex')).toString();
    
    const updates = generateCrashGame({
      roundId: round,
      vrfRandom,
      serverSeed,
      chainId: 10143,
      startTimestamp: Math.floor(Date.now() / 1000).toString(),
      tickIntervalMs: 100
    });
    
    const finalMultiplier = updates[updates.length - 1]?.bar?.high || 0;
    
    // Update stats
    if (finalMultiplier === 1.00) {
      stats.instantCrashes++;
    }
    if (finalMultiplier <= 1.01) {
      stats.nearInstantCrashes++;
    }
    if (finalMultiplier <= 2.00) {
      stats.lowCrashes++;
    }
    
    stats.minMultiplier = Math.min(stats.minMultiplier, finalMultiplier);
    stats.maxMultiplier = Math.max(stats.maxMultiplier, finalMultiplier);
    
    // Bucket distribution
    const bucket = Math.floor(finalMultiplier);
    stats.distribution.set(bucket, (stats.distribution.get(bucket) || 0) + 1);
    
    // Log instant crashes
    if (finalMultiplier <= 1.01) {
      console.log(`Round ${round}: 🔴 CRASH at ${finalMultiplier}x`);
    }
    
    // Progress indicator
    if (round % 100 === 0) {
      process.stdout.write(`\rProgress: ${round}/${NUM_ROUNDS} rounds tested...`);
    }
  }
  
  console.log(`\n\n${'='.repeat(60)}`);
  console.log(`📊 INSTANT CRASH TEST RESULTS`);
  console.log(`${'='.repeat(60)}\n`);
  
  console.log(`Total Rounds: ${NUM_ROUNDS}`);
  console.log(`\nInstant Crashes (1.00x): ${stats.instantCrashes} (${(stats.instantCrashes / NUM_ROUNDS * 100).toFixed(2)}%)`);
  console.log(`Near-Instant (≤1.01x): ${stats.nearInstantCrashes} (${(stats.nearInstantCrashes / NUM_ROUNDS * 100).toFixed(2)}%)`);
  console.log(`Low Crashes (≤2.00x): ${stats.lowCrashes} (${(stats.lowCrashes / NUM_ROUNDS * 100).toFixed(2)}%)`);
  console.log(`\nMin Multiplier: ${stats.minMultiplier.toFixed(2)}x`);
  console.log(`Max Multiplier: ${stats.maxMultiplier.toFixed(2)}x`);
  console.log(`\nNote: Multipliers shown are rounded to 2 decimal places (what players see)`);
  console.log(`      Raw multipliers before rounding can be slightly lower (e.g., 1.004x → 1.00x)`);
  
  console.log(`\nDistribution (by multiplier bucket [bucket, bucket+1)):`);
  const sortedBuckets = Array.from(stats.distribution.entries())
    .sort((a, b) => a[0] - b[0])
    .slice(0, 20); // Show first 20 buckets
  
  for (const [bucket, count] of sortedBuckets) {
    const bar = '█'.repeat(Math.floor(count / NUM_ROUNDS * 50));
    // Label: [bucket, bucket+1) means bucket.00x to (bucket+1).00x (exclusive)
    console.log(`  [${bucket}x, ${(bucket + 1).toFixed(0)}x): ${count.toString().padStart(4)} (${(count / NUM_ROUNDS * 100).toFixed(1)}%) ${bar}`);
  }
  
  console.log(`\n${'='.repeat(60)}`);
  
  // Verdict
  if (stats.instantCrashes > 0) {
    console.log(`✅ PASS: Instant crashes (1.00x) are possible!`);
    console.log(`   Found ${stats.instantCrashes} instant crashes out of ${NUM_ROUNDS} rounds.`);
  } else if (stats.nearInstantCrashes > 0) {
    console.log(`⚠️  WARNING: No exact 1.00x crashes, but found ${stats.nearInstantCrashes} near-instant crashes (≤1.01x)`);
    console.log(`   This might be due to rounding. Check if raw multiplier can be exactly 1.00x.`);
  } else {
    console.log(`❌ FAIL: No instant or near-instant crashes detected!`);
    console.log(`   Minimum multiplier was ${stats.minMultiplier.toFixed(2)}x`);
    console.log(`   This suggests the formula prevents instant crashes.`);
  }
  
  if (stats.minMultiplier > 1.01) {
    console.log(`\n❌ CRITICAL: Minimum multiplier is ${stats.minMultiplier.toFixed(2)}x`);
    console.log(`   This means instant crashes are mathematically impossible!`);
    console.log(`   Check for Math.max(1.01, ...) or similar clamping.`);
  }
  
  console.log(`${'='.repeat(60)}\n`);
}

testInstantCrashes();

