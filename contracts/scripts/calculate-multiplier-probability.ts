import { ethers } from "ethers";
import crypto from "crypto";
import { generateCrashGame } from './crash-game-backend.js';

/**
 * Calculate the probability of reaching a target multiplier
 * by simulating many games and counting successes
 */
async function calculateMultiplierProbability(
  targetMultiplier: number,
  numSimulations: number = 10000,
  roundId: number = 1,
  chainId: number = 10143
) {
  console.log(`\nCalculating probability of reaching ${targetMultiplier}x multiplier`);
  console.log(`Simulating ${numSimulations} games...\n`);

  let reachedTarget = 0;
  let totalGames = 0;
  let instantCrashes = 0;
  let maxReached = 0;
  let minReached = Infinity;

  const startTimestamp = Math.floor(Date.now() / 1000).toString();
  const tickIntervalMs = 100;

  for (let i = 0; i < numSimulations; i++) {
    // Generate random VRF and server seed for each simulation
    const vrfRandom = BigInt('0x' + crypto.randomBytes(32).toString('hex'));
    const serverSeed = crypto.randomBytes(32).toString('hex');

    try {
      const result = generateCrashGame({
        roundId,
        vrfRandom: vrfRandom.toString(),
        serverSeed,
        chainId,
        startTimestamp,
        tickIntervalMs
      });

      // Access the updates array from the result
      const updates = result.updates;

      // Find the maximum multiplier reached during the game
      let maxMultiplierInGame = 1.00;
      let gameReachedTarget = false;

      for (const update of updates) {
        if (update.gameState === 2) { // RUNNING state
          const multiplier = update.currentValue / 100000;
          maxMultiplierInGame = Math.max(maxMultiplierInGame, multiplier);

          if (multiplier >= targetMultiplier) {
            gameReachedTarget = true;
          }
        }
      }

      // Check final crash multiplier
      const finalMultiplier = updates[updates.length - 1]?.bar?.high || 0;
      if (finalMultiplier >= targetMultiplier) {
        gameReachedTarget = true;
      }

      if (gameReachedTarget) {
        reachedTarget++;
      }

      maxReached = Math.max(maxReached, maxMultiplierInGame);
      minReached = Math.min(minReached, maxMultiplierInGame);

      if (finalMultiplier <= 1.01) {
        instantCrashes++;
      }

      totalGames++;

      // Progress indicator
      if ((i + 1) % 1000 === 0) {
        const progress = ((i + 1) / numSimulations * 100).toFixed(1);
        const currentProb = (reachedTarget / totalGames * 100).toFixed(2);
        process.stdout.write(`\rProgress: ${progress}% | Current probability: ${currentProb}%`);
      }
    } catch (error) {
      // Skip failed simulations
      continue;
    }
  }

  const probability = (reachedTarget / totalGames) * 100;
  const instantCrashRate = (instantCrashes / totalGames) * 100;

  console.log(`\n\n${'='.repeat(60)}`);
  console.log(`Results for ${targetMultiplier}x multiplier:`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Total simulations: ${totalGames}`);
  console.log(`Games that reached ${targetMultiplier}x: ${reachedTarget}`);
  console.log(`Probability: ${probability.toFixed(4)}%`);
  console.log(`\nAdditional Statistics:`);
  console.log(`  Instant crashes (<=1.01x): ${instantCrashes} (${instantCrashRate.toFixed(2)}%)`);
  console.log(`  Maximum multiplier reached: ${maxReached.toFixed(2)}x`);
  console.log(`  Minimum multiplier reached: ${minReached.toFixed(2)}x`);
  console.log(`${'='.repeat(60)}\n`);

  return {
    targetMultiplier,
    probability,
    reachedTarget,
    totalGames,
    instantCrashes,
    instantCrashRate,
    maxReached,
    minReached
  };
}

/**
 * Calculate probabilities for multiple target multipliers
 */
async function calculateMultipleProbabilities(
  targetMultipliers: number[],
  numSimulations: number = 10000
) {
  console.log(`\nCalculating probabilities for multiple multipliers`);
  console.log(`Targets: ${targetMultipliers.join('x, ')}x`);
  console.log(`Simulations per target: ${numSimulations}\n`);

  const results: Array<{
    target: number;
    probability: number;
    reached: number;
    total: number;
  }> = [];

  for (const target of targetMultipliers) {
    const result = await calculateMultiplierProbability(target, numSimulations);
    results.push({
      target: result.targetMultiplier,
      probability: result.probability,
      reached: result.reachedTarget,
      total: result.totalGames
    });
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Summary Table`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Target Multiplier | Probability | Reached/Total`);
  console.log(`${'-'.repeat(60)}`);
  for (const result of results) {
    console.log(
      `${result.target.toString().padStart(6)}x        | ${result.probability.toFixed(4).padStart(8)}% | ${result.reached}/${result.total}`
    );
  }
  console.log(`${'='.repeat(60)}\n`);

  return results;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: npm run calculate-probability <targetMultiplier> [numSimulations]');
    console.log('   OR: npm run calculate-probability --multiple <multiplier1> <multiplier2> ... [numSimulations]');
    console.log('\nExamples:');
    console.log('  npm run calculate-probability 2.0        # Calculate prob of reaching 2.0x');
    console.log('  npm run calculate-probability 5.0 50000 # Calculate with 50k simulations');
    console.log('  npm run calculate-probability --multiple 1.5 2.0 3.0 5.0 10.0');
    process.exit(1);
  }

  const isMultiple = args[0] === '--multiple';

  if (isMultiple) {
    const multipliers = args.slice(1, -1).map(Number).filter(n => !isNaN(n));
    const numSims = args[args.length - 1] ? parseInt(args[args.length - 1]) : 10000;

    if (multipliers.length === 0) {
      console.error('Error: Please provide at least one multiplier');
      process.exit(1);
    }

    await calculateMultipleProbabilities(multipliers, numSims);
  } else {
    const targetMultiplier = parseFloat(args[0]);
    const numSimulations = args[1] ? parseInt(args[1]) : 10000;

    if (isNaN(targetMultiplier) || targetMultiplier <= 0) {
      console.error('Error: Target multiplier must be a positive number');
      process.exit(1);
    }

    await calculateMultiplierProbability(targetMultiplier, numSimulations);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

