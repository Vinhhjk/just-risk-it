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


  console.log(`\nDeploying PythEntropyTest to ${networkName}...`);
  console.log(`Chain ID: ${network.chainId}`);
  console.log(`Pyth Entropy: ${network.entropy}\n`);

  // Setup provider and wallet
  const provider = new ethers.JsonRpcProvider(network.rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  
  console.log(`Deployer address: ${wallet.address}`);
  
  const balance = await provider.getBalance(wallet.address);
  console.log(`Balance: ${ethers.formatEther(balance)} MON\n`);

  // Read contract artifact
  const contractPath = path.resolve(__dirname, "../artifacts/contracts/PythEntropyTest.sol/PythEntropyTest.json");
  if (!fs.existsSync(contractPath)) {
    throw new Error('Contract not compiled. Run: npm run compile');
  }

  const contractArtifact = JSON.parse(fs.readFileSync(contractPath, 'utf-8'));
  const factory = new ethers.ContractFactory(contractArtifact.abi, contractArtifact.bytecode, wallet);

  // Deploy contract
  console.log(`Deploying PythEntropyTest...`);
  
  const contract = await factory.deploy(network.entropy);
  await contract.waitForDeployment();

  const contractAddress = await contract.getAddress();
  console.log(`\nContract deployed!`);
  console.log(`Address: ${contractAddress}`);
  console.log(`Explorer: ${network.blockExplorer}/address/${contractAddress}\n`);

  // Save deployment info
  const deploymentInfo = {
    network: networkName,
    chainId: network.chainId,
    contractAddress,
    entropy: network.entropy,
    deployer: wallet.address,
    txHash: contract.deploymentTransaction()?.hash,
    blockNumber: contract.deploymentTransaction()?.blockNumber,
  };

  const deploymentPath = path.resolve(__dirname, `../deployments/pyth-test-${networkName}.json`);
  fs.mkdirSync(path.dirname(deploymentPath), { recursive: true });
  fs.writeFileSync(deploymentPath, JSON.stringify(deploymentInfo, null, 2));
  
  console.log(`Deployment info saved to: ${deploymentPath}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

