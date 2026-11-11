// Backfill historical monthly snapshots for the past 2 years
// Assumes same holdings throughout the period
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

// Fetch USD MEP historical data (YPFD.BA ARS / YPF USD as proxy, or use AL30/AL30D)
// We'll use the ratio approach: fetch YPFD.BA (ARS) and YPF (USD) from Yahoo
async function fetchDollarRates() {
  // MEP proxy: YPFD.BA (ARS in BYMA) vs YPF (NYSE in USD)
  // CCL proxy: similar but YPFD.BA / YPF with different settlement
  // Simpler: use GD30.BA and a known USD reference
  // Best approach: fetch YPFD.BA and YPF, ratio = MEP rate
  console.log('Fetching dollar rate proxies...');
  
  let ypfBA, ypfNY;
  try {
    ypfBA = await yahooHistory('YPFD.BA', 2.5); // YPF CEDEAR in ARS
    ypfNY = await yahooHistory('YPF', 2.5);     // YPF in USD (NYSE)
  } catch (e) {
    console.error('Could not fetch YPF for MEP calc:', e.message);
    return null;
  }

  // Build date->price maps
  const baMap = {};
  ypfBA.forEach(p => { baMap[p.date] = p.close; });
  const nyMap = {};
  ypfNY.forEach(p => { nyMap[p.date] = p.close; });

  // YPF CEDEAR ratio is 1:1, so MEP ≈ YPFD.BA price / YPF price
  const rates = {};
  for (const date of Object.keys(baMap)) {
    if (nyMap[date] && baMap[date] && nyMap[date] > 0) {
      const mep = baMap[date] / nyMap[date];
      // CCL is typically 1-3% above MEP
      rates[date] = { mep, ccl: mep * 1.02 };
    }
  }
  
  return rates;
}

async function run() {
  console.log('Fetching historical prices for all tickers...');
  
  // Fetch all histories
  const histories = {};
  for (const h of portfolio.holdings) {
    try {
      console.log(`  Fetching ${h.yahooTicker}...`);
      histories[h.ticker] = await yahooHistory(h.yahooTicker, 2.5);
      console.log(`    Got ${histories[h.ticker].length} data points`);
    } catch (e) {
      console.error(`  Failed for ${h.ticker}: ${e.message}`);
      histories[h.ticker] = [];
    }
    // Rate limit
    await new Promise(r => setTimeout(r, 500));
  }

  // Fetch dollar rates
  const dollarRates = await fetchDollarRates();
  console.log(`Dollar rates: ${dollarRates ? Object.keys(dollarRates).length : 0} days`);

  // Build price maps by date
  const priceMaps = {};
  for (const [ticker, data] of Object.entries(histories)) {
    priceMaps[ticker] = {};
    data.forEach(p => { priceMaps[ticker][p.date] = p.close; });
  }

  // Generate monthly snapshots (last day of each month with data)
  const now = new Date();
  const startDate = new Date(now);
  startDate.setFullYear(startDate.getFullYear() - 2);
  
  // Collect all unique dates where we have at least some data
  const allDates = new Set();
  Object.values(priceMaps).forEach(map => {
    Object.keys(map).forEach(d => allDates.add(d));
  });
  const sortedDates = [...allDates].sort();

  // Group by month, pick last available date per month
  const monthlyDates = {};
  for (const d of sortedDates) {
    const ym = d.substring(0, 7); // YYYY-MM
    monthlyDates[ym] = d; // Last date wins
  }

  console.log(`\nGenerating ${Object.keys(monthlyDates).length} monthly snapshots...`);

  let created = 0;
  for (const [ym, date] of Object.entries(monthlyDates).sort()) {
    if (date < startDate.toISOString().split('T')[0]) continue;
    
    const filePath = path.join(DATA_DIR, `${date}.json`);
    
    // Find closest price for each holding on this date
    let holdingsValue = 0;
    let totalInvested = 0;
    const holdingsSnapshot = portfolio.holdings.map(h => {
      const priceMap = priceMaps[h.ticker] || {};
      // Find exact or closest prior date
      let price = priceMap[date] || h.fallbackPrice || 0;
      if (!price) {
        // Find closest prior date
        const dates = Object.keys(priceMap).filter(d => d <= date).sort();
        if (dates.length > 0) price = priceMap[dates[dates.length - 1]];
      }
      
      const qty = h.nominalDivisor ? h.quantity / h.nominalDivisor : h.quantity;
      const currentValue = qty * price;
      const invested = qty * h.avgPrice;
      holdingsValue += currentValue;
      totalInvested += invested;
      
      return {
        ticker: h.ticker,
        type: h.type,
        quantity: h.quantity,
        avgPrice: h.avgPrice,
        currentPrice: price,
        currentValue,
        invested,
        gainLoss: currentValue - invested,
        gainLossPercent: invested > 0 ? ((currentValue - invested) / invested) * 100 : 0
      };
    });

    // Get dollar rate for this date
    let dollarMep = null, dollarCcl = null;
    if (dollarRates) {
      const rateEntry = dollarRates[date];
      if (rateEntry) {
        dollarMep = rateEntry.mep;
        dollarCcl = rateEntry.ccl;
      } else {
        // Find closest prior date
        const rateDates = Object.keys(dollarRates).filter(d => d <= date).sort();
        if (rateDates.length > 0) {
          const closest = dollarRates[rateDates[rateDates.length - 1]];
          dollarMep = closest.mep;
          dollarCcl = closest.ccl;
        }
      }
    }

    // Include cash in total
    const cashArs = portfolio.cash.ars || 0;
    const cashUsdInArs = dollarMep ? (portfolio.cash.usd || 0) * dollarMep : 0;
    const totalValue = holdingsValue + cashArs + cashUsdInArs;

    const snapshot = {
      date,
      timestamp: new Date(date + 'T18:00:00-03:00').toISOString(),
      totalValue,
      holdingsValue,
      totalInvested,
      totalGainLoss: totalValue - totalInvested,
      totalGainLossPercent: totalInvested > 0 ? ((totalValue - totalInvested) / totalInvested) * 100 : 0,
      cash: portfolio.cash,
      dollarMep,
      dollarCcl,
      totalValueUsdMep: dollarMep ? totalValue / dollarMep : null,
      totalValueUsdCcl: dollarCcl ? totalValue / dollarCcl : null,
      holdings: holdingsSnapshot
    };

    fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
    console.log(`  ${date}: $${(totalValue/1000000).toFixed(1)}M ARS (holdings $${(holdingsValue/1000000).toFixed(1)}M) | MEP: ${dollarMep ? '$'+dollarMep.toFixed(0) : 'N/A'} | USD MEP: ${snapshot.totalValueUsdMep ? '$'+(snapshot.totalValueUsdMep).toFixed(0) : 'N/A'}`);
    created++;
  }

  console.log(`\nDone! Created ${created} snapshots.`);
}

run().catch(console.error);
