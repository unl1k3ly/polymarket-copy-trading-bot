#!/usr/bin/env ts-node

/**
 * Reconciliation script:
 * - Fetch trader positions for all USER_ADDRESSES
 * - Fetch bot positions for PROXY_WALLET
 * - Identify bot-only positions (trader is out) and attempt to close them
 */

import mongoose from 'mongoose';
import { ENV } from '../config/env';
import connectDB from '../config/db';
import createClobClient from '../utils/createClobClient';
import fetchData from '../utils/fetchData';
import postOrder from '../utils/postOrder';
import getMyBalance from '../utils/getMyBalance';
import Logger from '../utils/logger';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';

const DATA_API_BASE = 'https://data-api.polymarket.com';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchPositions = async (address: string) => {
    const url = `${DATA_API_BASE}/positions?user=${address}`;
    return fetchData(url);
};

const main = async () => {
    await connectDB();
    const clobClient = await createClobClient();

    // Fetch trader positions for all tracked addresses
    const traderPositionsResponses = await Promise.all(
        ENV.USER_ADDRESSES.map((addr) => fetchPositions(addr))
    );
    const traderOpenConditions = new Set<string>();
    traderPositionsResponses.forEach((positions: any[]) => {
        positions
            .filter((p) => (p.currentValue || 0) > 0.01)
            .forEach((p) => traderOpenConditions.add(p.conditionId));
    });

    // Fetch bot positions
    const botPositions: UserPositionInterface[] = await fetchPositions(ENV.PROXY_WALLET);
    const botOpen = botPositions.filter((p) => (p.currentValue || 0) > 0.01);
    const botOnly = botOpen.filter((p) => !traderOpenConditions.has(p.conditionId));

    if (botOnly.length === 0) {
        Logger.success('No stale positions to reconcile');
        await mongoose.connection.close();
        return;
    }

    Logger.header('RECONCILE POSITIONS');
    Logger.info(`Found ${botOnly.length} stale position(s) to close`);

    const my_balance = await getMyBalance(ENV.PROXY_WALLET);

    for (const pos of botOnly) {
        try {
            Logger.info(
                `Closing stale position ${pos.title || pos.asset} (${pos.conditionId}) size ${pos.size}`
            );

            // Synthetic trade: treat as full exit
            const syntheticTrade: UserActivityInterface = {
                _id: new mongoose.Types.ObjectId(),
                proxyWallet: ENV.PROXY_WALLET,
                timestamp: Math.floor(Date.now() / 1000),
                conditionId: pos.conditionId,
                type: 'TRADE',
                size: pos.size,
                usdcSize: (pos.size || 0) * (pos.curPrice || pos.avgPrice || 0),
                transactionHash: '',
                price: pos.curPrice || pos.avgPrice || 0.5,
                asset: pos.asset,
                side: 'SELL',
                outcomeIndex: pos.outcomeIndex,
                title: pos.title,
                slug: pos.slug,
                icon: pos.icon,
                eventSlug: pos.eventSlug,
                outcome: pos.outcome,
                name: 'reconcile',
                pseudonym: 'reconcile',
                bio: '',
                profileImage: '',
                profileImageOptimized: '',
                bot: false,
                botExcutedTime: 0,
                myBoughtSize: pos.size,
            };

            await postOrder(
                clobClient,
                'sell',
                pos,
                undefined,
                syntheticTrade,
                my_balance,
                0,
                'reconcile'
            );
            // small pause to avoid hammering
            await sleep(250);
        } catch (error) {
            Logger.error(
                `Failed to close ${pos.title || pos.asset}: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
        }
    }

    await mongoose.connection.close();
};

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
});
