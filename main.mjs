import puppeteer from 'puppeteer'
import fs from 'fs'
import FormData from 'form-data'
import fetch from 'node-fetch'

async function testUpload() {
  const browser = await puppeteer.launch()
  const page = await browser.newPage()
  await page.goto('https://example.com')
  const base64 = await page.screenshot({ encoding: 'base64' })
  console.log('截图长度', base64.length)

  const form = new FormData()
  form.append('format', 'json')
  form.append('source', Buffer.from(base64, 'base64'), { filename: 'test.png' })

  const response = await fetch('https://img.piacg.eu.org/api/1/upload', {
    method: 'POST',
    headers: {
      'X-API-Key': process.env.CHEVERETO_API_KEY,
      ...form.getHeaders(),
    },
    body: form,
  })
  const result = await response.json()
  console.log(result)

  await browser.close()
}

testUpload()
