import { ethers } from "ethers";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const NETWORKS = {
  'monad-testnet': {
    chainId: 10143,
    rpcUrl: 'https://testnet-rpc.monad.xyz',
    blockExplorer: 'https://testnet.monadexplorer.com',
  },
  'monad-mainnet': {
    chainId: 143,
    rpcUrl: 'https://rpc.monad.xyz',
    blockExplorer: 'https://monadexplorer.com',
  },
};

const CRASH_GAME_ABI = [
  'function withdrawHouseEdge() external',
  'function operator() external view returns (address)',
  'function token() external view returns (address)',
];

const ERC20_ABI = [
  'function balanceOf(address account) external view returns (uint256)',
  'function decimals() external view returns (uint8)',
  'function symbol() external view returns (string)',
];

async function main() {
  const networkName = process.env.NETWORK || 'monad-testnet';
  const network = NETWORKS[networkName as keyof typeof NETWORKS];
  
  if (!network) {
    throw new Error(`Unknown network: ${networkName}`);
  }

  const privateKey = process.env.DEPLOYER_PK;
  if (!privateKey) {
    throw new Error('DEPLOYER_PK not found in environment variables');
  }

  // Get contract address from env or deployment file
  let contractAddress: string | undefined = process.env.CRASH_GAME_CONTRACT;
  if (!contractAddress) {
    const deploymentPath = path.resolve(__dirname, `../deployments/crash-game-${networkName}.json`);
    if (fs.existsSync(deploymentPath)) {
      const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf-8'));
      contractAddress = deployment.contractAddress;
      console.log(`Using contract address from deployment file: ${contractAddress}\n`);
    } else {
      throw new Error('CRASH_GAME_CONTRACT not set and deployment file not found. Set CRASH_GAME_CONTRACT env variable or deploy the contract first.');
    }
  }

  if (!contractAddress) {
    throw new Error('CRASH_GAME_CONTRACT is required');
  }

  console.log(`\nWithdrawing contract balance from CrashGame`);
  console.log(`Network: ${networkName}`);
  console.log(`Contract: ${contractAddress}\n`);

  const provider = new ethers.JsonRpcProvider(network.rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  
  console.log(`Operator address: ${wallet.address}`);
  
  const balance = await provider.getBalance(wallet.address);
  console.log(`Operator balance: ${ethers.formatEther(balance)} MON\n`);

  const contractPath = path.resolve(__dirname, "../artifacts/contracts/CrashGame.sol/CrashGame.json");
  
  if (!fs.existsSync(contractPath)) {
    throw new Error('Contract not compiled. Run: npm run compile');
  }

  const contractArtifact = JSON.parse(fs.readFileSync(contractPath, 'utf-8'));
  const contract = new ethers.Contract(contractAddress, contractArtifact.abi, wallet);

  // Verify caller is the operator
  const operator = await contract.operator();
//   if (operator.toLowerCase() !== wallet.address.toLowerCase()) {
//     throw new Error(`Address ${wallet.address} is not the operator. Operator is: ${operator}`);
//   }

//   console.log(`Verified: ${wallet.address} is the operator\n`);

  // Get token address and check balance
  const tokenAddress = await contract.token();
  const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  
  const tokenSymbol = await tokenContract.symbol();
  const tokenDecimals = await tokenContract.decimals();
  const contractBalance = await tokenContract.balanceOf(contractAddress);
  
  const formattedBalance = ethers.formatUnits(contractBalance, tokenDecimals);
  
  console.log(`Contract token balance: ${formattedBalance} ${tokenSymbol}`);
  
  if (contractBalance === 0n) {
    console.log(`\nNo balance to withdraw. Exiting.\n`);
    return;
  }

  console.log(`\nWithdrawing ${formattedBalance} ${tokenSymbol} to operator ${wallet.address}...\n`);

  // Withdraw
  const tx = await contract.withdrawHouseEdge();
  console.log(`Transaction sent: ${tx.hash}`);
  console.log(`Explorer: ${network.blockExplorer}/tx/${tx.hash}\n`);
  
  console.log(`Waiting for confirmation...`);
  const receipt = await tx.wait();
  
  console.log(`\nWithdrawal successful!`);
  console.log(`   Block: ${receipt.blockNumber}`);
  console.log(`   Gas used: ${receipt.gasUsed.toString()}`);
  
  // Verify balance is now zero
  const newBalance = await tokenContract.balanceOf(contractAddress);
  if (newBalance === 0n) {
    console.log(`Contract balance is now 0 ${tokenSymbol}\n`);
  } else {
    console.log(`Contract still has ${ethers.formatUnits(newBalance, tokenDecimals)} ${tokenSymbol} (unexpected)\n`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

