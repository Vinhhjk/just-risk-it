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
    entropy: '0x825c0390f379c631f3cf11a82a37d20bddf93c07', // Pyth Entropy on Monad testnet
    blockExplorer: 'https://testnet.monadexplorer.com',
  },
  'monad-mainnet': {
    chainId: 143,
    rpcUrl: 'https://rpc.monad.xyz',
    entropy: '0xd458261e832415cfd3bae5e416fdf3230ce6f134', // TODO: Get mainnet address
    blockExplorer: 'https://monadexplorer.com',
  },
};

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

  console.log(`\nDeploying CrashGame to ${networkName}...`);
  console.log(`Chain ID: ${network.chainId}`);
  console.log(`Pyth Entropy: ${network.entropy}\n`);

  const provider = new ethers.JsonRpcProvider(network.rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  
  console.log(`Deployer address: ${wallet.address}`);
  
  const balance = await provider.getBalance(wallet.address);
  console.log(`Balance: ${ethers.formatEther(balance)} MON\n`);

  const contractPath = path.resolve(__dirname, "../artifacts/contracts/CrashGame.sol/CrashGame.json");
  
  if (!fs.existsSync(contractPath)) {
    throw new Error('Contract not compiled. Run: npm run compile');
  }

  const contractArtifact = JSON.parse(fs.readFileSync(contractPath, 'utf-8'));
  const factory = new ethers.ContractFactory(contractArtifact.abi, contractArtifact.bytecode, wallet);

  // Operator is the deployer (can be changed later via setOperator)
  const operator = wallet.address;
  
  // Get token address from env or deployment file
  let tokenAddress: string | undefined = process.env.MOCK_TOKEN;
  if (!tokenAddress) {
    // Try to get from token deployment file
    const tokenDeploymentPath = path.resolve(__dirname, `../deployments/token-${networkName}.json`);
    if (fs.existsSync(tokenDeploymentPath)) {
      const tokenDeployment = JSON.parse(fs.readFileSync(tokenDeploymentPath, 'utf-8'));
      tokenAddress = tokenDeployment.contractAddress;
      console.log(`Using token address from deployment file: ${tokenAddress}\n`);
    } else {
      throw new Error('MOCK_TOKEN not set and token deployment file not found. Deploy token first or set MOCK_TOKEN env variable.');
    }
  }
  
  console.log(`Deploying CrashGame...`);
  console.log(`Operator: ${operator}`);
  console.log(`Token: ${tokenAddress}\n`);
  
  const contract = await factory.deploy(network.entropy, operator, tokenAddress);
  await contract.waitForDeployment();

  const contractAddress = await contract.getAddress();
  console.log(`\nContract deployed!`);
  console.log(`Address: ${contractAddress}`);
  console.log(`Explorer: ${network.blockExplorer}/address/${contractAddress}\n`);

  const deploymentInfo = {
    network: networkName,
    chainId: network.chainId,
    contractAddress,
    entropy: network.entropy,
    token: tokenAddress,
    deployer: wallet.address,
    operator: operator,
    txHash: contract.deploymentTransaction()?.hash,
  };

  const deploymentPath = path.resolve(__dirname, `../deployments/crash-game-${networkName}.json`);
  fs.mkdirSync(path.dirname(deploymentPath), { recursive: true });
  fs.writeFileSync(deploymentPath, JSON.stringify(deploymentInfo, null, 2));
  
  console.log(`Deployment info saved to: ${deploymentPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

