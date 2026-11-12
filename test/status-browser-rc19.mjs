import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

export async function verifyStatusBrowser(host, playwright, chrome, expected) {
  const { chromium } = await import(pathToFileURL(resolve(playwright)).href)
  const { launchUrl, env } = host.browserOptions()
  const browser = await chromium.launch({
    executablePath: resolve(chrome), env, args: ['--disable-background-networking'],
  })
  try {
    const page = await browser.newPage({ locale: 'en-US' })
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => true })
    })
    page.setDefaultTimeout(12_000)
    await page.goto(launchUrl)
    const welcome = page.getByRole('button', { name: 'Continue', exact: true })
    if (await welcome.waitFor({ timeout: 2500 }).then(() => true, () => false)) await welcome.click()
    const workspace = page.getByText('synthetic-workspace', { exact: true }).first()
    const main = page.getByText(expected.main, { exact: true }).first()
    await workspace.waitFor()
    if (!await main.isVisible()) await workspace.click()
    await main.click()
    const sidebar = page.getByRole('button', { name: 'Open right sidebar', exact: true })
    if (await sidebar.isVisible()) await sidebar.click()
    await page.getByRole('button', { name: /dsh-session-bridge/ }).click()
    const log = page.locator('[data-dsh-bridge-status-log]')
    await log.waitFor()
    for (const title of expected.windows) await log.getByText(title, { exact: true }).first().waitFor()
    const text = await log.innerText()
    assert.match(text, /cancelled|withdrawn|已撤回|已取消/i)
    assert.match(text, /return(?:ed)?|result|回传/i)
    for (const body of expected.bodies) assert(!text.includes(body))
    for (const id of expected.ids) assert(!text.includes(id))
    const panel = log.locator('..')
    const control = panel.locator('[data-dsh-bridge-master]')
    assert.equal(await panel.getByRole('checkbox').count(), 1)
    assert(!/allowlist|白名单/i.test(await panel.innerText()))
    assert.equal(await control.isChecked(), false)
    await control.check()
    await host.until(async () => {
      const { namespaces } = await host.rpc('settings/describe')
      return namespaces.find(({ ns }) => ns === 'dsh-session-bridge-settings').value.enabled === true
    }, 'right-sidebar master control writes enabled state')
    await log.getByText(expected.windows[0], { exact: true }).first().waitFor()
    console.log('PASS Chrome shows only the master control and the current window activity, including past returns and withdrawals while disabled after restart')
  } finally {
    await browser.close()
  }
}
