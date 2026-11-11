// Backfill daily snapshots for the past 2 years using Yahoo Finance daily data
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data', 'snapshots');
const portfolio = JSON.parse(fs.readFileSync(path.join(__dirname, 'portfolio.json'), 'utf8'));

fs.mkdirSync(DATA_DIR, { recursive: true });

async function yahooHistory(ticker, years = 2.5) {
  const period1 = Math.floor((Date.now() - years * 365 * 86400000) / 1000);
  const period2 = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${period1}&period2=${period2}&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status} for ${ticker}`);
  const json = await res.json();
  const result = json.chart.result[0];
  const timestamps = result.timestamp || [];
  const quotes = result.indicators.quote[0];
  return timestamps.map((t, i) => ({
    date: new Date(t * 1000).toISOString().split('T')[0],
    close: quotes.close[i]
  })).filter(q => q.close != null);
}

async function run() {
  console.log('Fetching daily historical prices...');

  // Fetch all histories
  const histories = {};
  for (const h of portfolio.holdings) {
    try {
      process.stdout.write(`  ${h.yahooTicker}...`);
      histories[h.ticker] = await yahooHistory(h.yahooTicker, 2.5);
      console.log(` ${histories[h.ticker].length} days`);
    } catch (e) {
      console.log(` FAILED: ${e.message}`);
      histories[h.ticker] = [];
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // Dollar rates via YPF proxy
  console.log('Fetching dollar rates (YPFD.BA / YPF)...');
  let ypfBA = [], ypfNY = [];
  try {
    ypfBA = await yahooHistory('YPFD.BA', 2.5);
    ypfNY = await yahooHistory('YPF', 2.5);
  } catch (e) {
    console.error('YPF fetch failed:', e.message);
  }

  const baMap = {}, nyMap = {};
  ypfBA.forEach(p => { baMap[p.date] = p.close; });
  ypfNY.forEach(p => { nyMap[p.date] = p.close; });

  const dollarRatesMap = {};
  for (const date of Object.keys(baMap)) {
    if (nyMap[date] && baMap[date] && nyMap[date] > 0) {
      const mep = baMap[date] / nyMap[date];
      dollarRatesMap[date] = { mep, ccl: mep * 1.02 };
    }
  }
  console.log(`Dollar rates: ${Object.keys(dollarRatesMap).length} days`);

  // Build price maps
  const priceMaps = {};
  for (const [ticker, data] of Object.entries(histories)) {
    priceMaps[ticker] = {};
    data.forEach(p => { priceMaps[ticker][p.date] = p.close; });
  }

  // Collect all trading dates where we have SPY data (most liquid)
  const spyDates = Object.keys(priceMaps['SPY'] || {}).sort();
  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  const startStr = twoYearsAgo.toISOString().split('T')[0];

  const tradingDates = spyDates.filter(d => d >= startStr);
  console.log(`\nGenerating ${tradingDates.length} daily snapshots...`);

  let created = 0, skipped = 0;
  for (const date of tradingDates) {
    const filePath = path.join(DATA_DIR, `${date}.json`);
    // Don't overwrite today's live snapshot
    if (fs.existsSync(filePath)) { skipped++; continue; }

    let holdingsValue = 0;
    let totalInvested = 0;

    const holdingsSnapshot = portfolio.holdings.map(h => {
      const priceMap = priceMaps[h.ticker] || {};
      let price = priceMap[date] || h.fallbackPrice || 0;
      if (!price) {
        const prior = Object.keys(priceMap).filter(d => d <= date).sort();
        if (prior.length > 0) price = priceMap[prior[prior.length - 1]];
      }
      const qty = h.nominalDivisor ? h.quantity / h.nominalDivisor : h.quantity;
      const currentValue = qty * price;
      const invested = qty * h.avgPrice;
      holdingsValue += currentValue;
      totalInvested += invested;
      return {
        ticker: h.ticker, type: h.type, quantity: h.quantity,
        avgPrice: h.avgPrice, currentPrice: price,
        currentValue, invested,
        gainLoss: currentValue - invested,
        gainLossPercent: invested > 0 ? ((currentValue - invested) / invested) * 100 : 0
      };
    });

    // Dollar rate
    let dollarMep = null, dollarCcl = null;
    const rateEntry = dollarRatesMap[date];
    if (rateEntry) {
      dollarMep = rateEntry.mep;
      dollarCcl = rateEntry.ccl;
    } else {
      const prior = Object.keys(dollarRatesMap).filter(d => d <= date).sort();
      if (prior.length > 0) {
        dollarMep = dollarRatesMap[prior[prior.length - 1]].mep;
        dollarCcl = dollarRatesMap[prior[prior.length - 1]].ccl;
      }
    }

    const cashArs = portfolio.cash.ars || 0;
    const cashUsdInArs = dollarMep ? (portfolio.cash.usd || 0) * dollarMep : 0;
    const totalValue = holdingsValue + cashArs + cashUsdInArs;

    const snapshot = {
      date,
      timestamp: new Date(date + 'T18:00:00-03:00').toISOString(),
      totalValue, holdingsValue, totalInvested,
      totalGainLoss: totalValue - totalInvested,
      totalGainLossPercent: totalInvested > 0 ? ((totalValue - totalInvested) / totalInvested) * 100 : 0,
      cash: portfolio.cash, dollarMep, dollarCcl,
      totalValueUsdMep: dollarMep ? totalValue / dollarMep : null,
      totalValueUsdCcl: dollarCcl ? totalValue / dollarCcl : null,
      holdings: holdingsSnapshot
    };

    fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
    created++;
  }

  console.log(`Done! Created ${created} snapshots, skipped ${skipped} existing.`);
}

run().catch(console.error);
