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

  // Setup provider and wallet first to get deployer address
  const provider = new ethers.JsonRpcProvider(network.rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  const deployerAddress = wallet.address;

  const recipient =  deployerAddress;
  const initialOwner = deployerAddress;

  console.log(`\nDeploying MockChogToken to ${networkName}...`);
  console.log(`Chain ID: ${network.chainId}\n`);
  
  console.log(`Deployer address: ${deployerAddress}`);
  console.log(`Recipient address: ${recipient}`);
  console.log(`Initial owner: ${initialOwner}`);
  
  const balance = await provider.getBalance(wallet.address);
  console.log(`Balance: ${ethers.formatEther(balance)} MON\n`);

  const contractPath = path.resolve(__dirname, "../artifacts/contracts/MockChogToken.sol/MockChogToken.json");
  
  if (!fs.existsSync(contractPath)) {
    throw new Error('Contract not compiled. Run: npm run compile');
  }

  const contractArtifact = JSON.parse(fs.readFileSync(contractPath, 'utf-8'));
  const factory = new ethers.ContractFactory(contractArtifact.abi, contractArtifact.bytecode, wallet);

  console.log(`Deploying MockChogToken...`);
  console.log(`Token name: Mock Chog Token`);
  console.log(`Token symbol: mCHOG`);
  console.log(`Initial supply: 10,000,000 mCHOG (to recipient)\n`);
  
  const contract = await factory.deploy(recipient, initialOwner);
  await contract.waitForDeployment();

  const contractAddress = await contract.getAddress();
  console.log(`\nContract deployed!`);
  console.log(`Address: ${contractAddress}`);
  console.log(`Explorer: ${network.blockExplorer}/address/${contractAddress}\n`);

  const deploymentInfo = {
    network: networkName,
    chainId: network.chainId,
    contractAddress,
    recipient,
    initialOwner,
    deployer: wallet.address,
    txHash: contract.deploymentTransaction()?.hash,
  };

  const deploymentPath = path.resolve(__dirname, `../deployments/token-${networkName}.json`);
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

