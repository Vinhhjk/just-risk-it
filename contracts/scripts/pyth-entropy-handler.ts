import { ethers } from "ethers";

interface EntropyHandlerConfig {
  entropy: ethers.Contract;
  contract: ethers.Contract; // The CrashGame contract (to parse events)
  network: {
    chainId: number;
    blockExplorer: string;
    revealDelayBlocks: number;
  };
  provider: ethers.Provider;
}

/**
 * Callback to request randomness from the contract
 */
type RequestRandomnessCallback = (roundId: number, fee: bigint) => Promise<ethers.ContractTransactionResponse>;

/**
 * Callback to read the settled entropy value from the contract
 */
type ReadEntropyValueCallback = (roundId: number) => Promise<bigint>;

interface EntropyResult {
  sequenceNumber: bigint;
  entropyRandom: bigint;
}

/**
 * Request randomness from Pyth Entropy and wait for callback
 * This handles the Pyth Entropy callback pattern
 */
export async function requestAndWaitForEntropy(
  config: EntropyHandlerConfig,
  requestRandomness: RequestRandomnessCallback,
  readEntropyValue: ReadEntropyValueCallback,
  roundId: number
): Promise<EntropyResult> {
  const { entropy, contract, network, provider } = config;
  
  // Step 1: Get the fee
  const fee = await entropy.getFeeV2();
  console.log(`   Fee: ${ethers.formatEther(fee)} MON`);

  // Step 2: Request randomness
  const requestTx = await requestRandomness(roundId, fee);
  const requestReceipt = await requestTx.wait();

  if (!requestReceipt) {
    throw new Error('Request transaction receipt is null');
  }

  // Get sequence number from event (parse from CrashGame contract, not entropy)
  const requestEvent = requestReceipt.logs.find((log: any) => {
    try {
      const parsed = contract.interface.parseLog(log);
      return parsed && parsed.name === 'RandomRequested';
    } catch {
      return false;
    }
  });

  let sequenceNumber: bigint | null = null;
  if (requestEvent) {
    const parsed = contract.interface.parseLog(requestEvent);
    sequenceNumber = parsed?.args[1]; // sequenceNumber is the second arg (roundId is first)
  }

  if (sequenceNumber === null) {
    throw new Error('Could not extract sequence number from event');
  }

  console.log(`Randomness requested in block ${requestReceipt.blockNumber}`);
  console.log(`TX: ${network.blockExplorer}/tx/${requestTx.hash}`);
  console.log(`Sequence Number: ${sequenceNumber}\n`);

  // Step 3: Wait for reveal delay blocks
  const currentBlock = await provider.getBlockNumber();
  const targetBlock = currentBlock + network.revealDelayBlocks;
  console.log(`   Waiting for ${network.revealDelayBlocks} blocks (current: ${currentBlock}, target: ${targetBlock})...`);
  
  while ((await provider.getBlockNumber()) < targetBlock) {
    await new Promise(resolve => setTimeout(resolve, 1000)); // Check every second
  }
  console.log(`   Reveal delay passed.\n`);

  // Step 4: Wait for callback (poll the contract)
  console.log(`   Waiting for entropy callback...`);
  let entropyRandom: bigint | null = null;
  let maxWaitTime = 120; // Wait up to 120 seconds
  let waited = 0;
  const pollInterval = 3; // Poll every 3 seconds

  while (waited < maxWaitTime && entropyRandom === null) {
    await new Promise(resolve => setTimeout(resolve, pollInterval * 1000));
    waited += pollInterval;

    try {
      const currentRandom = await readEntropyValue(roundId);
      if (currentRandom !== 0n) {
        entropyRandom = currentRandom;
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

  if (entropyRandom === null) {
    throw new Error(`Random number not received after ${maxWaitTime} seconds. The callback may have failed.`);
  }

  return {
    sequenceNumber,
    entropyRandom,
  };
}

