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

const FACTORY = '0x72cc6E4DE47f673062c41C67505188144a0a3D84'

const GUARD_MESSAGE = 'CrowdfundingModule: tokenAddress custodied for another DAO'

// Validates that the cross-tenant token-confusion guard is live on a given
// network by simulating the attack path via eth_call:
//   1. Find a "victim" LP token that the module currently custodies (balance > 0).
//   2. Find a different DAO with its own LP to act as the "attacker".
//   3. eth_call initSale(_token = victim LP) from the attacker DAO.
//   4. Expect revert with GUARD_MESSAGE — proves patch is deployed.
const main = async () => {
  const chainId = network.config.chainId
  if (!chainId) throw new Error('chainId missing')
  const proxy = PROXY_BY_CHAIN[chainId]
  if (!proxy) throw new Error(`No proxy for chainId ${chainId}`)

  console.log(`=== Guard validation on chainId ${chainId} ===`)
  console.log(`Proxy: ${proxy}`)

  const factoryAbi = ['function getDaos() view returns (address[])']
  const daoAbi = ['function lp() view returns (address)']
  const erc20Abi = ['function balanceOf(address) view returns (uint256)']

  const factory = await ethers.getContractAt(factoryAbi, FACTORY)
  const daos: string[] = await factory.getDaos()
  console.log(`Factory knows ${daos.length} DAOs`)

  // Collect (dao, lp, custodied?) rows. Early-exit once we have at least one
  // custodied LP AND a different DAO with a non-custodied LP — no need to scan
  // all 145 DAOs on chains with long lists.
  type Row = { dao: string; lp: string; custodied: boolean }
  const rows: Row[] = []
  let haveVictim = false
  let haveAttacker = false
  for (const d of daos) {
    try {
      const lp: string = await (await ethers.getContractAt(daoAbi, d)).lp()
      if (!lp || lp === ethers.constants.AddressZero) continue
      const bal = await (await ethers.getContractAt(erc20Abi, lp)).balanceOf(
        proxy
      )
      const custodied = bal.gt(0)
      rows.push({ dao: d, lp, custodied })
      if (custodied) haveVictim = true
      else haveAttacker = true
      if (haveVictim && haveAttacker && rows.length >= 2) break
    } catch {
      continue
    }
  }
  const custodied = rows.filter((r) => r.custodied)
  const available = rows.filter((r) => !r.custodied)
  console.log(`DAOs with usable lp(): ${rows.length}`)
  console.log(`LPs custodied by module (victims): ${custodied.length}`)

  if (custodied.length === 0) {
    console.log(`WARN: no custodied LP found — cannot simulate attack. SKIP.`)
    return
  }

  // Pick: attacker = any DAO whose LP is NOT custodied (cleaner test — avoids
  // "already exists" false negative). Victim LP is from the first custodied row.
  const victim = custodied[0]
  const attacker =
    available.find(
      (r) => r.dao.toLowerCase() !== victim.dao.toLowerCase()
    ) ||
    rows.find((r) => r.dao.toLowerCase() !== victim.dao.toLowerCase())
  if (!attacker) {
    console.log(`WARN: no attacker DAO candidate. SKIP.`)
    return
  }

  console.log(`Victim DAO:   ${victim.dao}`)
  console.log(`Victim LP:    ${victim.lp} (custodied)`)
  console.log(`Attacker DAO: ${attacker.dao}`)
  console.log(`Attacker LP:  ${attacker.lp}`)

  // Craft initSale call data.
  const initSaleIface = new ethers.utils.Interface([
    'function initSale(address _currency,address _token,uint256 _rate,uint256 _saleAmount,uint256 _endTimestamp,uint256 _vestingId,uint256[] _entranceLimits,bool[4] _limits,tuple(address investor,uint256 allocation)[] _whitelist)'
  ])
  const now = Math.floor(Date.now() / 1000)
  const data = initSaleIface.encodeFunctionData('initSale', [
    ethers.constants.AddressZero,
    victim.lp, // ← cross-tenant token (attack)
    ethers.utils.parseEther('1'),
    ethers.utils.parseEther('1000'),
    now + 7 * 24 * 3600,
    0,
    [0, 0],
    [false, false, false, false],
    []
  ])

  // eth_call with from = attacker DAO (no signing, pure simulation).
  let reverted = false
  let revertMessage = ''
  try {
    await ethers.provider.call({
      from: attacker.dao,
      to: proxy,
      data
    })
  } catch (e: any) {
    reverted = true
    const err = e?.error?.message || e?.reason || e?.message || String(e)
    revertMessage = err
  }

  console.log()
  if (!reverted) {
    console.error(`FAIL: eth_call did NOT revert. Guard appears NOT applied.`)
    process.exitCode = 1
    return
  }
  if (revertMessage.includes(GUARD_MESSAGE)) {
    console.log(`PASS — reverted with guard message:`)
    console.log(`  "${GUARD_MESSAGE}"`)
    console.log(`Patch is live on chainId ${chainId}.`)
  } else {
    console.log(`Reverted, but message != guard:`)
    console.log(`  ${revertMessage}`)
    console.log(
      `(Acceptable reasons: "only for DAOs" if attacker not recognised, ` +
        `"already exists" if attacker has open sale, "Invalid vesting" etc. ` +
        `In these cases guard wasn't reached — pick another attacker.)`
    )
    // Attempt a second candidate if possible (walk forward).
    const second =
      available.find(
        (r) =>
          r.dao.toLowerCase() !== victim.dao.toLowerCase() &&
          r.dao.toLowerCase() !== attacker.dao.toLowerCase()
      ) ||
      rows.find(
        (r) =>
          r.dao.toLowerCase() !== victim.dao.toLowerCase() &&
          r.dao.toLowerCase() !== attacker.dao.toLowerCase()
      )
    if (!second) {
      process.exitCode = 1
      return
    }
    console.log(`Retrying with alternate attacker ${second.dao}…`)
    try {
      await ethers.provider.call({
        from: second.dao,
        to: proxy,
        data
      })
      console.error(`FAIL on retry: no revert.`)
      process.exitCode = 1
    } catch (e: any) {
      const err2 = e?.error?.message || e?.reason || e?.message || String(e)
      if (err2.includes(GUARD_MESSAGE)) {
        console.log(`PASS (on retry) — reverted with guard message.`)
        console.log(`Patch is live on chainId ${chainId}.`)
      } else {
        console.error(`INCONCLUSIVE: ${err2}`)
        process.exitCode = 1
      }
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
