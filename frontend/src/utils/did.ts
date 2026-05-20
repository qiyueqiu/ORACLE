import { ethers } from 'ethers';

// 计算 secret 的哈希值（用于生成 commitment）
export function hashSecret(secret: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(secret));
}

// 生成与合约一致的 commitment: keccak256(abi.encodePacked(nullifier, secretHash))
// 注意：需要先生成 nullifier 和 secretHash，然后计算 commitment
export function generateCommitment(nullifier: string, secretHash: string): string {
  return ethers.solidityPackedKeccak256(
    ['bytes32', 'bytes32'],
    [nullifier, secretHash]
  );
}

export function generateNullifier(did: string, secret: string): string {
  return ethers.keccak256(
    ethers.toUtf8Bytes(`nullifier:${did}:${secret}`)
  );
}

// Generate a random DID (for demo purposes)
export function generateDID(name: string): string {
  const random = Math.random().toString(36).substring(2, 10);
  return `did:asb:${name}-${random}`;
}

// Generate a random secret (for demo purposes)
export function generateSecret(): string {
  const random = Math.random().toString(36).substring(2, 20);
  return random;
}
