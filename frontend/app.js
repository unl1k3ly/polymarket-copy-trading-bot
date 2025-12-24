/**
 * Polymarket Shadow Trader - Analytics Dashboard
 * Main Application JavaScript
 */

// =====================================================
// CONFIGURATION
// =====================================================
const CONFIG = {
    API_BASE: '', // served by backend proxy
    GAMMA_API: 'https://gamma-api.polymarket.com',
    TRADER_ADDRESS: '',
    BOT_ADDRESS: '',
    POSITIONS_LIMIT: 50,
    ACTIVITY_LIMIT: 20,
    REFRESH_INTERVAL: 30, // seconds
};

// =====================================================
// STATE
// =====================================================
let state = {
    traderPositions: [],
    botPositions: [],
    traderActivity: [],
    botActivity: [],
    traderAddress: '',
    botAddress: '',
    marketData: {}, // slug -> market data with spread, bid/ask, volume
    isLoading: false,
    countdown: CONFIG.REFRESH_INTERVAL,
    // UI State
    activeTab: {
        trader: 'open',
        bot: 'open'
    }
};

// =====================================================
// API FUNCTIONS
// =====================================================
async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    return response.json();
}

async function fetchMarketData(slug) {
    try {
        // Use CORS proxy for Gamma API (needed when running from file://)
        const targetUrl = `${CONFIG.GAMMA_API}/markets?slug=${slug}`;
        const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`;
        const response = await fetch(proxyUrl);
        if (!response.ok) return null;
        const data = await response.json();
        return data[0] || null;
    } catch (e) {
        console.warn(`Failed to fetch market data for ${slug}:`, e);
        return null;
    }
}

async function fetchAllMarketData(positions) {
    const uniqueSlugs = [...new Set(positions.map(p => p.slug))];
    const results = await Promise.allSettled(
        uniqueSlugs.map(slug => fetchMarketData(slug))
    );

    const marketData = {};
    results.forEach((result, i) => {
        if (result.status === 'fulfilled' && result.value) {
            marketData[uniqueSlugs[i]] = result.value;
        }
    });
    return marketData;
}

// =====================================================
// DATA LOADING
// =====================================================
async function loadAllData() {
    if (state.isLoading) return;

    state.isLoading = true;
    const refreshBtn = document.getElementById('refreshBtn');
    refreshBtn.classList.add('spinning');

    try {
        const [configPayload, positionsPayload, activityPayload] = await Promise.all([
            fetchJson('/api/config'),
            fetchJson(`/api/positions?limit=${CONFIG.POSITIONS_LIMIT}`),
            fetchJson(`/api/activity?limit=${CONFIG.ACTIVITY_LIMIT}`),
        ]);

        const configTrader = Array.isArray(configPayload?.traders) ? configPayload.traders[0] : undefined;
        const primaryTrader = positionsPayload.traders?.[0];
        state.traderAddress = primaryTrader?.address || configTrader || CONFIG.TRADER_ADDRESS;
        state.botAddress = positionsPayload.bot?.address || configPayload?.proxyWallet || CONFIG.BOT_ADDRESS;

        state.traderPositions = primaryTrader?.positions || [];
        state.botPositions = positionsPayload.bot?.positions || [];
        state.traderActivity = activityPayload.traders?.[0]?.activity || [];
        state.botActivity = activityPayload.bot?.activity || [];

        updateIdentityLabels(state.traderAddress, state.botAddress);

        renderAll();
        updateLastUpdate();
    } catch (error) {
        console.error('Failed to load data:', error);
    } finally {
        state.isLoading = false;
        refreshBtn.classList.remove('spinning');
        state.countdown = CONFIG.REFRESH_INTERVAL;
    }
}

// =====================================================
// RENDER FUNCTIONS
// =====================================================
function renderAll() {
    renderStats();
    renderPairedPositions();
    renderActivity('traderActivity', state.traderActivity);
    renderActivity('botActivity', state.botActivity);
    renderCorrelation();
}

function renderStats() {
    // Position counts (only open positions, not closed)
    const traderOpenCount = state.traderPositions.filter(p => (p.currentValue || 0) > 0.01).length;
    const botOpenCount = state.botPositions.filter(p => (p.currentValue || 0) > 0.01).length;
    document.getElementById('traderPositionCount').textContent = traderOpenCount;
    document.getElementById('botPositionCount').textContent = botOpenCount;

    // Match rate
    const matchRate = calculateMatchRate();
    document.getElementById('matchRate').textContent = `${matchRate}%`;

    // Bot total PnL - include ALL positions (open + closed)
    // Closed positions (currentValue = 0) represent realized losses
    const totalPnl = state.botPositions.reduce((sum, p) => sum + (p.cashPnl || 0), 0);
    const pnlElement = document.getElementById('botTotalPnl');
    pnlElement.textContent = formatCurrency(totalPnl);
    pnlElement.className = `stat-value ${totalPnl >= 0 ? 'positive' : 'negative'}`;
}

function renderPairedPositions() {
    const container = document.getElementById('pairedPositions');

    // Get all open positions from both sides
    const traderPositions = state.traderPositions.filter(p => (p.currentValue || 0) > 0.01);
    const botPositions = state.botPositions.filter(p => (p.currentValue || 0) > 0.01);

    // Create lookup by title + outcome (the unique market identifier)
    const getKey = p => `${p.title}|${p.outcome}`;

    const traderByKey = {};
    traderPositions.forEach(p => { traderByKey[getKey(p)] = p; });

    const botByKey = {};
    botPositions.forEach(p => { botByKey[getKey(p)] = p; });

    // Find MATCHED positions only (both trader and bot have the same market)
    const matchedPairs = [];
    Object.keys(traderByKey).forEach(key => {
        if (botByKey[key]) {
            matchedPairs.push({
                key,
                trader: traderByKey[key],
                bot: botByKey[key]
            });
        }
    });

    // Find unmatched positions
    const traderOnly = traderPositions.filter(p => !botByKey[getKey(p)]);
    const botOnly = botPositions.filter(p => !traderByKey[getKey(p)]);

    // Calculate aggregate slippage stats for matched pairs
    let totalSlippage = 0;
    let avgSlippagePct = 0;
    if (matchedPairs.length > 0) {
        matchedPairs.forEach(pair => {
            const priceDiff = pair.bot.avgPrice - pair.trader.avgPrice;
            totalSlippage += priceDiff * pair.bot.size;
        });
        avgSlippagePct = matchedPairs.reduce((sum, pair) => {
            return sum + ((pair.bot.avgPrice - pair.trader.avgPrice) / pair.trader.avgPrice * 100);
        }, 0) / matchedPairs.length;
    }

    container.innerHTML = `
        <div class="paired-summary">
            <div class="paired-stat">
                <span class="label">Matched Trades</span>
                <span class="value">${matchedPairs.length}</span>
            </div>
            <div class="paired-stat">
                <span class="label">Avg Slippage</span>
                <span class="value ${avgSlippagePct > 0 ? 'negative' : avgSlippagePct < 0 ? 'positive' : ''}">${avgSlippagePct >= 0 ? '+' : ''}${avgSlippagePct.toFixed(2)}%</span>
            </div>
            <div class="paired-stat">
                <span class="label">Trader Only</span>
                <span class="value warning">${traderOnly.length}</span>
            </div>
            <div class="paired-stat">
                <span class="label">Bot Only</span>
                <span class="value">${botOnly.length}</span>
            </div>
        </div>

        ${matchedPairs.length === 0 ? `
            <div class="no-matches">
                <p>No matched positions found</p>
                <p class="sub">Trader has ${traderOnly.length} positions, Bot has ${botOnly.length} positions in different markets</p>
            </div>
        ` : `
            <table class="paired-table">
                <thead>
                    <tr>
                        <th>Market</th>
                        <th class="num-col">Trader Entry</th>
                        <th class="num-col">Bot Entry</th>
                        <th class="num-col">Price Spread</th>
                        <th class="num-col">Size Diff</th>
                        <th class="num-col">PnL Diff</th>
                    </tr>
                </thead>
                <tbody>
                    ${matchedPairs.map(pair => {
        const t = pair.trader;
        const b = pair.bot;

        // Price spread (bot - trader entry price)
        const priceDiffCents = formatPriceCents(b.avgPrice) - formatPriceCents(t.avgPrice);
        const slippagePct = t.avgPrice > 0 ? ((b.avgPrice - t.avgPrice) / t.avgPrice * 100) : 0;
        const spreadClass = priceDiffCents > 0 ? 'bad' : priceDiffCents < 0 ? 'good' : 'neutral';

        // Size difference
        const sizeDiff = b.size - t.size;
        const sizePct = t.size > 0 ? ((b.size - t.size) / t.size * 100) : 0;

        // PnL difference
        const pnlDiff = (b.cashPnl || 0) - (t.cashPnl || 0);

        return `
                            <tr>
                                <td>
                                    <div class="paired-market">
                                        <img src="${t.icon}" alt="" onerror="this.style.display='none'">
                                        <div class="paired-market-info">
                                            <div class="paired-market-title" title="${t.title}">${t.title}</div>
                                            <div class="paired-market-outcome">${t.outcome}</div>
                                        </div>
                                    </div>
                                </td>
                                <td class="num-col">${formatPriceCents(t.avgPrice)}¢</td>
                                <td class="num-col">${formatPriceCents(b.avgPrice)}¢</td>
                                <td class="num-col">
                                    <span class="slippage-indicator ${spreadClass}">
                                        ${priceDiffCents >= 0 ? '+' : ''}${priceDiffCents}¢
                                        <small>(${slippagePct >= 0 ? '+' : ''}${slippagePct.toFixed(1)}%)</small>
                                    </span>
                                </td>
                                <td class="num-col">
                                    <span class="${sizeDiff > 0 ? 'positive' : sizeDiff < 0 ? 'negative' : ''}">
                                        ${sizeDiff >= 0 ? '+' : ''}${formatNumber(sizeDiff)}
                                        <small>(${sizePct >= 0 ? '+' : ''}${sizePct.toFixed(0)}%)</small>
                                    </span>
                                </td>
                                <td class="num-col">
                                    <span class="${pnlDiff >= 0 ? 'positive' : 'negative'}">
                                        ${pnlDiff >= 0 ? '+' : ''}${formatCurrency(pnlDiff)}
                                    </span>
                                </td>
                            </tr>
                        `;
    }).join('')}
                </tbody>
            </table>
        `}
        
        ${traderOnly.length > 0 ? `
            <div class="unmatched-section">
                <h5>❌ Not Copied (Trader Only)</h5>
                <div class="unmatched-list">
                    ${traderOnly.map(p => `
                        <div class="unmatched-item">
                            <span class="title" title="${p.title}">${p.title}</span>
                            <span class="outcome">${p.outcome}</span>
                            <span class="price">${formatPriceCents(p.avgPrice)}¢</span>
                        </div>
                    `).join('')}
                </div>
            </div>
        ` : ''}
    `;
}

function renderPositions(containerId, positions, panelType) {
    const container = document.getElementById(containerId);
    const isTrader = panelType === 'trader';
    const activeTab = isTrader ? state.activeTab.trader : state.activeTab.bot;

    // Separate open vs closed positions
    // A position is "closed" if currentValue is 0 or negligible (fully sold)
    const openPositions = positions.filter(p => (p.currentValue || 0) > 0.01);
    const closedPositions = positions.filter(p => (p.currentValue || 0) <= 0.01);

    // Select based on tab
    const displayPositions = activeTab === 'open' ? openPositions : closedPositions;

    if (!displayPositions || displayPositions.length === 0) {
        const emptyMessage = activeTab === 'closed'
            ? 'No closed positions'
            : 'No positions found';
        container.innerHTML = `
            <div class="empty-state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"/>
                    <path d="M16 16s-1.5-2-4-2-4 2-4 2"/>
                    <line x1="9" y1="9" x2="9.01" y2="9"/>
                    <line x1="15" y1="9" x2="15.01" y2="9"/>
                </svg>
                <p>${emptyMessage}</p>
            </div>
        `;
        return;
    }

    container.innerHTML = displayPositions.map((pos, index) => {
        const tradeDirection = pos.outcome === 'Up' ? 'trade-up' : 'trade-down';

        return `
        <div class="position-card ${tradeDirection}" style="animation-delay: ${index * 0.05}s">
            <img class="position-icon" src="${pos.icon}" alt="${pos.title}" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 40 40%22><rect fill=%22%231a1d26%22 width=%2240%22 height=%2240%22/></svg>'">
            <div class="position-info">
                <div class="position-title" title="${pos.title}">${pos.title}</div>
                <div class="position-meta">
                    <span class="outcome-badge ${pos.outcome === 'Up' ? 'outcome-up' : 'outcome-down'}">
                        ${pos.outcome}
                    </span>
                    <span>${formatNumber(pos.size)} @ ${formatPriceCents(pos.avgPrice)}¢</span>
                    <span>→ ${formatPriceCents(pos.curPrice)}¢</span>
                </div>
            </div>
            <div class="position-stats">
                <div class="position-value">${formatCurrency(pos.currentValue)}</div>
                <div class="position-pnl ${pos.cashPnl >= 0 ? 'positive' : 'negative'}">
                    ${pos.cashPnl >= 0 ? '+' : ''}${formatCurrency(pos.cashPnl)}
                    <span class="pnl-percent">(${pos.percentPnl >= 0 ? '+' : ''}${pos.percentPnl.toFixed(1)}%)</span>
                </div>
            </div>
        </div>
    `;
    }).join('');
}

function renderActivity(containerId, activities) {
    const container = document.getElementById(containerId);

    if (!activities || activities.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                </svg>
                <p>No recent activity</p>
            </div>
        `;
        return;
    }

    container.innerHTML = activities
        .filter(a => a.type === 'TRADE')
        .map((activity, index) => `
            <div class="activity-item" style="animation-delay: ${index * 0.03}s">
                <div class="activity-side ${activity.side === 'BUY' ? 'side-buy' : 'side-sell'}">
                    ${activity.side}
                </div>
                <div class="activity-details">
                    <div class="activity-market" title="${activity.title}">${activity.title}</div>
                    <div class="activity-outcome">${activity.outcome}</div>
                </div>
                <div class="activity-amount">
                    <div class="activity-size">${formatNumber(activity.size)}</div>
                    <div class="activity-price">@ ${formatPriceCents(activity.price)}¢</div>
                </div>
                <div class="activity-time">${formatRelativeTime(activity.timestamp)}</div>
            </div>
        `).join('');
}

function renderTradeComparison() {
    const container = document.getElementById('tradeComparison');

    // Match bot trades to trader trades
    const traderTrades = state.traderActivity.filter(a => a.type === 'TRADE');
    const botTrades = state.botActivity.filter(a => a.type === 'TRADE');

    const matchedTrades = [];

    traderTrades.forEach(traderTrade => {
        // Find corresponding bot trade on same condition within 10 minutes
        const botTrade = botTrades.find(b =>
            b.conditionId === traderTrade.conditionId &&
            b.side === traderTrade.side &&
            b.timestamp > traderTrade.timestamp &&
            b.timestamp - traderTrade.timestamp < 600 // 10 minutes
        );

        if (botTrade && traderTrade.price > 0) {
            const slippagePercent = ((botTrade.price - traderTrade.price) / traderTrade.price) * 100;
            matchedTrades.push({
                title: traderTrade.title,
                outcome: traderTrade.outcome,
                side: traderTrade.side,
                traderPrice: traderTrade.price,
                traderSize: traderTrade.size,
                botPrice: botTrade.price,
                botSize: botTrade.size,
                slippage: slippagePercent,
                traderTime: traderTrade.timestamp,
                botTime: botTrade.timestamp,
                delay: botTrade.timestamp - traderTrade.timestamp
            });
        }
    });

    if (matchedTrades.length === 0) {
        container.innerHTML = `
            <div class="no-matches">
                <p>No matched trades found in recent activity</p>
                <p style="font-size: 0.8rem; margin-top: 0.5rem;">Trades are matched when bot copies the same market/side within 10 minutes</p>
            </div>
        `;
        return;
    }

    container.innerHTML = `
        <table class="trade-comparison-table">
            <thead>
                <tr>
                    <th>Market</th>
                    <th>Side</th>
                    <th>Trader</th>
                    <th>Bot</th>
                    <th>Slippage</th>
                    <th>Delay</th>
                </tr>
            </thead>
            <tbody>
                ${matchedTrades.map(trade => {
        const slippageClass = trade.slippage > 0 ? 'positive' : trade.slippage < 0 ? 'negative' : 'neutral';
        const slippageSign = trade.slippage > 0 ? '+' : '';
        const priceDiff = formatPriceCents(trade.botPrice) - formatPriceCents(trade.traderPrice);
        const priceDiffStr = priceDiff >= 0 ? `+${priceDiff}¢` : `${priceDiff}¢`;
        return `
                        <tr>
                            <td>
                                <div class="trade-market">
                                    <div class="trade-market-info">
                                        <div class="trade-market-title" title="${trade.title}">${trade.title}</div>
                                        <div class="trade-market-outcome">${trade.outcome}</div>
                                    </div>
                                </div>
                            </td>
                            <td>
                                <span class="activity-side ${trade.side === 'BUY' ? 'side-buy' : 'side-sell'}">${trade.side}</span>
                            </td>
                            <td class="price-cell trader">${formatPriceCents(trade.traderPrice)}¢ <span class="size-detail">× ${formatNumber(trade.traderSize)}</span></td>
                            <td class="price-cell bot">${formatPriceCents(trade.botPrice)}¢ <span class="size-detail">× ${formatNumber(trade.botSize)}</span></td>
                            <td class="slippage-cell ${slippageClass}">${priceDiffStr} <span class="slip-pct">(${slippageSign}${trade.slippage.toFixed(1)}%)</span></td>
                            <td class="time-cell">${trade.delay}s</td>
                        </tr>
                    `;
    }).join('')}
            </tbody>
        </table>
    `;
}

function renderCorrelation() {
    const container = document.getElementById('correlationMetrics');

    // Calculate simple bot stats
    const botOpen = state.botPositions.filter(p => (p.currentValue || 0) > 0.01);
    const botTotalValue = botOpen.reduce((sum, p) => sum + (p.currentValue || 0), 0);
    const botTotalPnl = state.botPositions.reduce((sum, p) => sum + (p.cashPnl || 0), 0);

    // Find best and worst positions from ALL positions (including closed)
    const allWithPnl = state.botPositions.filter(p => p.cashPnl !== undefined && p.cashPnl !== null);
    const sortedByPnl = [...allWithPnl].sort((a, b) => (b.cashPnl || 0) - (a.cashPnl || 0));
    const bestPos = sortedByPnl[0];
    const worstPos = sortedByPnl[sortedByPnl.length - 1];

    container.innerHTML = `
        <div class="correlation-card">
            <div class="correlation-title">Bot Portfolio Value</div>
            <div class="correlation-value">${formatCurrency(botTotalValue)}</div>
            <div class="correlation-description">
                ${botOpen.length} open positions
            </div>
        </div>
        
        <div class="correlation-card">
            <div class="correlation-title">Bot Total PnL</div>
            <div class="correlation-value" style="color: ${botTotalPnl >= 0 ? 'var(--accent-success)' : 'var(--accent-danger)'}">${botTotalPnl >= 0 ? '+' : ''}${formatCurrency(botTotalPnl)}</div>
            <div class="correlation-description">
                Realized + unrealized
            </div>
        </div>
        
        ${bestPos ? `
        <div class="correlation-card">
            <div class="correlation-title">Best Position</div>
            <div class="correlation-value" style="color: var(--accent-success)">${bestPos.cashPnl >= 0 ? '+' : ''}${formatCurrency(bestPos.cashPnl)}</div>
            <div class="correlation-description" title="${bestPos.title}">
                ${bestPos.title.substring(0, 25)}...
            </div>
        </div>
        ` : ''}
        
        ${worstPos && worstPos !== bestPos ? `
        <div class="correlation-card">
            <div class="correlation-title">Worst Position</div>
            <div class="correlation-value" style="color: var(--accent-danger)">${worstPos.cashPnl >= 0 ? '+' : ''}${formatCurrency(worstPos.cashPnl)}</div>
            <div class="correlation-description" title="${worstPos.title}">
                ${worstPos.title.substring(0, 25)}...
            </div>
        </div>
        ` : ''}
    `;
}

function renderMismatches() {
    const container = document.getElementById('mismatchAnalysis');

    // Find positions trader has but bot doesn't (open positions only)
    const botConditions = new Set(state.botPositions.filter(p => (p.currentValue || 0) > 0.01).map(p => p.conditionId));
    const traderOpenPositions = state.traderPositions.filter(p => (p.currentValue || 0) > 0.01);
    const botMissing = traderOpenPositions.filter(p => !botConditions.has(p.conditionId));

    // Find positions bot has but trader doesn't (bot holding stale positions)
    const traderConditions = new Set(state.traderPositions.filter(p => (p.currentValue || 0) > 0.01).map(p => p.conditionId));
    const botOpenPositions = state.botPositions.filter(p => (p.currentValue || 0) > 0.01);
    const botExtra = botOpenPositions.filter(p => !traderConditions.has(p.conditionId));

    container.innerHTML = `
    < div class="mismatch-panel missing" >
            <div class="mismatch-panel-header">
                <h4>🚫 Bot Missing</h4>
                <span class="count">${botMissing.length}</span>
            </div>
            <div class="mismatch-list">
                ${botMissing.length === 0 ? '<div class="empty-state" style="padding:1rem;"><p>All synced ✓</p></div>' :
            botMissing.map(p => `
                    <div class="mismatch-item">
                        <img src="${p.icon}" alt="">
                        <div class="mismatch-item-info">
                            <div class="mismatch-item-title" title="${p.title}">${p.title}</div>
                            <div class="mismatch-item-meta">${p.outcome} • Size: ${formatNumber(p.size)}</div>
                        </div>
                        <div class="mismatch-item-value">${formatCurrency(p.currentValue)}</div>
                    </div>
                `).join('')}
            </div>
        </div >

    <div class="mismatch-panel extra">
        <div class="mismatch-panel-header">
            <h4>⚠️ Bot Holding (Trader Exited)</h4>
            <span class="count">${botExtra.length}</span>
        </div>
        <div class="mismatch-list">
            ${botExtra.length === 0 ? '<div class="empty-state" style="padding:1rem;"><p>No stale positions</p></div>' :
            botExtra.map(p => `
                    <div class="mismatch-item">
                        <img src="${p.icon}" alt="">
                        <div class="mismatch-item-info">
                            <div class="mismatch-item-title" title="${p.title}">${p.title}</div>
                            <div class="mismatch-item-meta">${p.outcome} • Size: ${formatNumber(p.size)}</div>
                        </div>
                        <div class="mismatch-item-value">${formatCurrency(p.currentValue)}</div>
                    </div>
                `).join('')}
        </div>
    </div>
`;
}

// =====================================================
// CALCULATION FUNCTIONS
// =====================================================
function calculateMatchRate() {
    const traderOpen = state.traderPositions.filter(p => (p.currentValue || 0) > 0.01);
    const botOpen = state.botPositions.filter(p => (p.currentValue || 0) > 0.01);

    if (traderOpen.length === 0) return 0;

    // Match by title + outcome
    const getKey = p => `${p.title}|${p.outcome}`;
    const botKeys = new Set(botOpen.map(getKey));

    let matches = 0;
    traderOpen.forEach(p => {
        if (botKeys.has(getKey(p))) matches++;
    });

    return Math.round((matches / traderOpen.length) * 100);
}

function calculateSizeRatio() {
    const sharedMarkets = findSharedMarkets();
    if (sharedMarkets.length === 0) return '0.00';

    let totalRatio = 0;
    sharedMarkets.forEach(market => {
        const traderPos = state.traderPositions.find(p => p.conditionId === market.conditionId);
        const botPos = state.botPositions.find(p => p.conditionId === market.conditionId);
        if (traderPos && botPos && traderPos.size > 0) {
            totalRatio += botPos.size / traderPos.size;
        }
    });

    return (totalRatio / sharedMarkets.length).toFixed(2);
}

function findSharedMarkets() {
    const botConditions = new Set(state.botPositions.map(p => p.conditionId));
    return state.traderPositions.filter(p => botConditions.has(p.conditionId));
}

function calculateAvgDelay() {
    // Compare recent trades on same markets
    if (state.traderActivity.length === 0 || state.botActivity.length === 0) {
        return 'N/A';
    }

    const delays = [];

    state.traderActivity.forEach(traderTrade => {
        // Find corresponding bot trade on same condition
        const botTrade = state.botActivity.find(b =>
            b.conditionId === traderTrade.conditionId &&
            b.side === traderTrade.side &&
            b.timestamp > traderTrade.timestamp &&
            b.timestamp - traderTrade.timestamp < 300 // Within 5 minutes
        );

        if (botTrade) {
            delays.push(botTrade.timestamp - traderTrade.timestamp);
        }
    });

    if (delays.length === 0) return 'N/A';

    const avgSeconds = delays.reduce((a, b) => a + b, 0) / delays.length;

    if (avgSeconds < 60) return `${Math.round(avgSeconds)} s`;
    if (avgSeconds < 3600) return `${Math.round(avgSeconds / 60)} m`;
    return `${Math.round(avgSeconds / 3600)} h`;
}

function calculateSlippage() {
    // Match bot trades to trader trades and calculate price difference
    if (state.traderActivity.length === 0 || state.botActivity.length === 0) {
        return { avg: 0, count: 0 };
    }

    const slippages = [];

    state.traderActivity.forEach(traderTrade => {
        if (traderTrade.type !== 'TRADE') return;

        // Find corresponding bot trade on same condition within 5 minutes
        const botTrade = state.botActivity.find(b =>
            b.type === 'TRADE' &&
            b.conditionId === traderTrade.conditionId &&
            b.side === traderTrade.side &&
            b.timestamp > traderTrade.timestamp &&
            b.timestamp - traderTrade.timestamp < 300
        );

        if (botTrade && traderTrade.price > 0) {
            // Slippage = (bot price - trader price) / trader price * 100
            // For BUY: positive means bot paid more (bad)
            // For SELL: positive means bot got less (bad)
            const slippagePercent = ((botTrade.price - traderTrade.price) / traderTrade.price) * 100;
            slippages.push({
                slippage: slippagePercent,
                traderPrice: traderTrade.price,
                botPrice: botTrade.price,
                side: traderTrade.side,
                title: traderTrade.title
            });
        }
    });

    if (slippages.length === 0) {
        return { avg: 0, count: 0 };
    }

    const avgSlippage = slippages.reduce((sum, s) => sum + Math.abs(s.slippage), 0) / slippages.length;

    return {
        avg: avgSlippage.toFixed(2),
        count: slippages.length,
        details: slippages
    };
}

// =====================================================
// FORMATTING FUNCTIONS
// =====================================================
function formatCurrency(value) {
    if (typeof value !== 'number') return '$0.00';
    const absValue = Math.abs(value);
    if (absValue >= 1000) {
        return `$${(value / 1000).toFixed(1)} k`;
    }
    return `$${value.toFixed(2)} `;
}

function formatNumber(value) {
    if (typeof value !== 'number') return '0';
    if (value >= 1000) {
        return `${(value / 1000).toFixed(1)} k`;
    }
    return value.toFixed(2);
}

function formatPrice(value) {
    if (typeof value !== 'number') return '0';
    return value.toFixed(2);
}

// Format price as cents (Polymarket prices are 0-1, representing $0.00-$1.00)
function formatPriceCents(value) {
    if (typeof value !== 'number') return '0';
    return Math.round(value * 100);
}

function formatVolume(value) {
    if (typeof value !== 'number') return '0';
    if (value >= 1000000) {
        return `${(value / 1000000).toFixed(1)} M`;
    }
    if (value >= 1000) {
        return `${(value / 1000).toFixed(1)} k`;
    }
    return value.toFixed(0);
}

function formatRelativeTime(timestamp) {
    const now = Math.floor(Date.now() / 1000);
    const diff = now - timestamp;

    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
}

function shortAddress(addr) {
    if (!addr || addr.length < 10) return addr || '--';
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function updateIdentityLabels(traderAddress, botAddress) {
    const traderShort = shortAddress(traderAddress);
    const botShort = shortAddress(botAddress);
    const traderLink = document.getElementById('traderProfile');
    const botLink = document.getElementById('botProfile');
    const pairedTitle = document.getElementById('pairedTitle');

    document.getElementById('traderAddressShort').textContent = traderShort;
    document.getElementById('botAddressShort').textContent = botShort;
    traderLink.href = `https://polymarket.com/profile/${traderAddress}`;
    botLink.href = `https://polymarket.com/profile/${botAddress}`;
    pairedTitle.textContent = `${traderShort} ↔ ${botShort}`;
}

function updateLastUpdate() {
    const now = new Date();
    document.getElementById('lastUpdate').textContent = now.toLocaleTimeString();
}

// =====================================================
// COUNTDOWN & AUTO-REFRESH
// =====================================================
function startCountdown() {
    setInterval(() => {
        state.countdown--;
        document.getElementById('countdown').textContent = state.countdown;

        if (state.countdown <= 0) {
            loadAllData();
        }
    }, 1000);
}

// =====================================================
// EVENT LISTENERS
// =====================================================
document.addEventListener('DOMContentLoaded', () => {
    // Initial load
    loadAllData();

    // Start countdown
    startCountdown();

    // Refresh button
    document.getElementById('refreshBtn').addEventListener('click', () => {
        loadAllData();
    });

    // Tab switching
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const panel = e.target.dataset.panel;
            const tab = e.target.dataset.tab;

            // Update active tab state
            if (panel === 'trader') {
                state.activeTab.trader = tab.replace('trader', '').toLowerCase();
            } else {
                state.activeTab.bot = tab.replace('bot', '').toLowerCase();
            }

            // Update button active states
            const panelElement = e.target.closest('.panel');
            panelElement.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');

            // Re-render only the affected panel
            if (panel === 'trader') {
                renderPositions('traderPositions', state.traderPositions, 'trader');
            } else {
                renderPositions('botPositions', state.botPositions, 'bot');
            }
        });
    });
});

// =====================================================
// VISIBILITY API - Pause when tab is hidden
// =====================================================
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        loadAllData();
    }
});
