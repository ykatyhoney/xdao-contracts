import 'dotenv/config'

import { ethers, network } from 'hardhat'

const PROXY_BY_CHAIN: Record<number, string> = {
  1: '0x711E14eBC41A8f1595433FA4409a50BC9838Fc03',
  56: '0x97330364E1a9209214ef5107a04798170D351b68',
  137: '0x8AC7D4cEA044fB0d0153c28d145aE350bA25f1bA',
  43114: '0x096BE3B573c74034Ba5A7E08DE412691DB9449fd',
  204: '0x096BE3B573c74034Ba5A7E08DE412691DB9449fd',
  10: '0xaB5836182cc9970695faa74A0890Cd7099955d5a',
  8453: '0x0b7b154c7dB7d50a500a3eF89eddc9A746787185',
  5000: '0x096BE3B573c74034Ba5A7E08DE412691DB9449fd',
  42161: '0x0cf784bba0FFA0a7006f3Ee7e4357E643a07F6e7',
  42170: '0x096BE3B573c74034Ba5A7E08DE412691DB9449fd'
}

const ERC1967_IMPL_SLOT = ethers.utils.hexZeroPad(
  ethers.BigNumber.from(
    ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes('eip1967.proxy.implementation')
    )
  )
    .sub(1)
    .toHexString(),
  32
)

const GUARD_PREFIX = 'CrowdfundingModule: tokenAddress'
const GUARD_SUFFIX = 'custodied for another DAO'

// Lightweight proof that the patched implementation is the active one:
// reads the proxy's ERC1967 slot, pulls the impl bytecode, searches for both
// chunks of the guard revert string. Solidity 0.8.x splits literals >32 bytes
// across PUSH32 ops, so we only verify each <=32-byte chunk contiguously.
const main = async () => {
  const chainId = network.config.chainId
  if (!chainId) throw new Error('chainId missing')
  const proxy = PROXY_BY_CHAIN[chainId]
  if (!proxy) throw new Error(`No proxy for chainId ${chainId}`)

  console.log(`=== Bytecode check on chainId ${chainId} ===`)
  console.log(`Proxy: ${proxy}`)

  const implRaw = await ethers.provider.getStorageAt(proxy, ERC1967_IMPL_SLOT)
  const impl = ethers.utils.getAddress('0x' + implRaw.slice(-40))
  console.log(`Impl:  ${impl}`)

  const code = await ethers.provider.getCode(impl)
  const codeLen = code.length
  console.log(`Bytecode len (hex chars): ${codeLen} (${(codeLen - 2) / 2} bytes)`)

  const hexPrefix = ethers.utils
    .hexlify(ethers.utils.toUtf8Bytes(GUARD_PREFIX))
    .slice(2)
    .toLowerCase()
  const hexSuffix = ethers.utils
    .hexlify(ethers.utils.toUtf8Bytes(GUARD_SUFFIX))
    .slice(2)
    .toLowerCase()
  const codeLower = code.toLowerCase()

  const hasPrefix = codeLower.includes(hexPrefix)
  const hasSuffix = codeLower.includes(hexSuffix)

  console.log(`Guard prefix present ("${GUARD_PREFIX}"): ${hasPrefix ? 'YES' : 'NO'}`)
  console.log(`Guard suffix present ("${GUARD_SUFFIX}"): ${hasSuffix ? 'YES' : 'NO'}`)

  if (hasPrefix && hasSuffix) {
    console.log(`PASS — patched implementation is active on chainId ${chainId}.`)
  } else {
    console.error(`FAIL — guard strings missing; patch NOT live on chainId ${chainId}.`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
