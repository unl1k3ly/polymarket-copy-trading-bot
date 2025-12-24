import express from 'express';
import cors from 'cors';
import path from 'path';
import axios from 'axios';
import dotenv from 'dotenv';
import { ENV } from '../config/env';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.DASHBOARD_PORT || '4000', 10);
const DATA_API_BASE = 'https://data-api.polymarket.com';

app.use(cors());
app.use(express.json());

// Helpers
const fetchJson = async (url: string) => {
    const response = await axios.get(url, { timeout: ENV.REQUEST_TIMEOUT_MS, headers: { 'User-Agent': 'polymarket-copy-dashboard' }, responseType: 'json' });
    return response.data;
};

const unique = <T>(arr: T[]) => Array.from(new Set(arr));

// Routes
app.get('/api/config', (_req, res) => {
    res.json({
        traders: ENV.USER_ADDRESSES,
        proxyWallet: ENV.PROXY_WALLET,
        slippage: {
            maxSlippagePct: ENV.MAX_SLIPPAGE_PCT,
            waitMs: ENV.SLIPPAGE_WAIT_MS,
            maxRetries: ENV.SLIPPAGE_MAX_RETRIES,
            minBookSizeUsd: ENV.MIN_BOOK_SIZE_USD,
            action: ENV.SLIPPAGE_ACTION,
        },
        copyStrategy: ENV.COPY_STRATEGY_CONFIG,
        aggregation: {
            enabled: ENV.TRADE_AGGREGATION_ENABLED,
            windowSeconds: ENV.TRADE_AGGREGATION_WINDOW_SECONDS,
        },
        timestamp: Date.now(),
    });
});

app.get('/api/positions', async (req, res) => {
    const limit = parseInt((req.query.limit as string) || '100', 10);
    try {
        const traderPromises = unique(ENV.USER_ADDRESSES).map(async (address) => ({
            address,
            positions: await fetchJson(`${DATA_API_BASE}/positions?user=${address}&limit=${limit}`),
        }));
        const traders = await Promise.all(traderPromises);
        const botPositions = await fetchJson(
            `${DATA_API_BASE}/positions?user=${ENV.PROXY_WALLET}&limit=${limit}`
        );
        res.json({
            traders,
            bot: { address: ENV.PROXY_WALLET, positions: botPositions },
            timestamp: Date.now(),
        });
    } catch (error) {
        const message =
            axios.isAxiosError(error) && error.response
                ? `${error.response.status} ${error.response.statusText}`
                : error instanceof Error
                  ? error.message
                  : 'Unknown error';
        res.status(500).json({ error: 'Failed to fetch positions', message });
    }
});

app.get('/api/activity', async (req, res) => {
    const limit = parseInt((req.query.limit as string) || '50', 10);
    try {
        const traderPromises = unique(ENV.USER_ADDRESSES).map(async (address) => ({
            address,
            activity: await fetchJson(`${DATA_API_BASE}/activity?user=${address}&limit=${limit}`),
        }));
        const traders = await Promise.all(traderPromises);
        const botActivity = await fetchJson(
            `${DATA_API_BASE}/activity?user=${ENV.PROXY_WALLET}&limit=${limit}`
        );
        res.json({
            traders,
            bot: { address: ENV.PROXY_WALLET, activity: botActivity },
            timestamp: Date.now(),
        });
    } catch (error) {
        const message =
            axios.isAxiosError(error) && error.response
                ? `${error.response.status} ${error.response.statusText}`
                : error instanceof Error
                  ? error.message
                  : 'Unknown error';
        res.status(500).json({ error: 'Failed to fetch activity', message });
    }
});

// Serve static frontend
const frontendDir = path.join(process.cwd(), 'frontend');
app.use(express.static(frontendDir));
app.get('*', (_req, res) => {
    res.sendFile(path.join(frontendDir, 'index.html'));
});

app.listen(PORT, () => {
    /* eslint-disable no-console */
    console.log(`Dashboard server listening on http://localhost:${PORT}`);
    /* eslint-enable no-console */
});
