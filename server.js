require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const { Web3 } = require('web3');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI;
if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI)
    .then(() => console.log('[MongoDB] Connected successfully to database'))
    .catch(err => console.error('[MongoDB] Connection error:', err.message));
} else {
  console.warn('[MongoDB] MONGODB_URI is not set in .env. Profile persistence is disabled.');
}

// Profile Schema
const profileSchema = new mongoose.Schema({
  walletAddress: { type: String, required: true, unique: true, lowercase: true, trim: true },
  username: { type: String, required: true, trim: true },
  hasDeposited: { type: Boolean, default: false },
  lastSeen: { type: Date, default: Date.now }
});

profileSchema.pre('save', function(next) {
  this.lastSeen = Date.now();
  next();
});

const Profile = mongoose.model('Profile', profileSchema);

// Middleware
app.use(cors());
app.use(express.json());

// Web3 Connection to BESC Hyperchain
const web3 = new Web3(process.env.BESC_RPC_URL || process.env.BSC_RPC_URL || 'https://testnet-rpc.beschyperchain.com');

// Treasury Account (loaded from private key)
let treasuryAccount;
try {
  const privateKey = process.env.TREASURY_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('TREASURY_PRIVATE_KEY not set in .env');
  }

  // Remove 0x prefix if present, then add it back
  const cleanPrivateKey = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey;
  treasuryAccount = web3.eth.accounts.privateKeyToAccount(cleanPrivateKey);
  web3.eth.accounts.wallet.add(treasuryAccount);

  console.log('[Treasury] Loaded treasury wallet:', treasuryAccount.address);
} catch (err) {
  console.error('[Treasury] Failed to load private key:', err.message);
  console.error('[Treasury] Make sure TREASURY_PRIVATE_KEY is set in .env file');
  process.exit(1);
}

// Configuration
const TIERS = {
  bronze: {
    deposit: parseFloat(process.env.BRONZE_DEPOSIT || '0.01'),
    payout: parseFloat(process.env.BRONZE_PAYOUT || '0.001')
  },
  silver: {
    deposit: parseFloat(process.env.SILVER_DEPOSIT || '0.05'),
    payout: parseFloat(process.env.SILVER_PAYOUT || '0.005')
  },
  gold: {
    deposit: parseFloat(process.env.GOLD_DEPOSIT || '0.10'),
    payout: parseFloat(process.env.GOLD_PAYOUT || '0.01')
  }
};
const REQUIRED_DEPOSIT = parseFloat(process.env.REQUIRED_DEPOSIT || '0.01'); // BESC fallback
const PAYOUT_AMOUNT = parseFloat(process.env.PAYOUT_AMOUNT || '0.001'); // BESC fallback
const SESSION_EXPIRE_TIME = 10 * 60 * 1000; // 10 minutes

// Deposit Destination Address (fallback to treasury wallet)
const DEPOSIT_ADDRESS = (process.env.DEPOSIT_ADDRESS || treasuryAccount.address).toLowerCase();
if (!web3.utils.isAddress(DEPOSIT_ADDRESS)) {
  console.error('[Configuration] Invalid DEPOSIT_ADDRESS specified');
  process.exit(1);
}
console.log('[Configuration] Deposits will be routed to and checked at:', DEPOSIT_ADDRESS);

// Whitelisted wallets (bypass deposit requirement for testing)
const WHITELISTED_WALLETS = [
  '0x409fc3c9c0f0d2cf12ddf60101f6a52f15827163',
  '0x04d81ef7dbcf0d094659f370d5edc91ea1c9075b'
].map(addr => addr.toLowerCase());

// In-memory storage (use database in production)
const sessions = new Map(); // sessionId -> session data
const paymentHistory = [];
const recentKills = new Map(); // Track recent kills to prevent duplicates (killerSessionId -> timestamp)

// Helper functions
function bescToWei(bescAmount) {
  return web3.utils.toWei(bescAmount.toString(), 'ether');
}

function weiToBesc(weiAmount) {
  return web3.utils.fromWei(weiAmount.toString(), 'ether');
}

function isWhitelisted(walletAddress) {
  return WHITELISTED_WALLETS.includes(walletAddress.toLowerCase());
}

// Clean up expired sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (session.status === 'pending' && now - session.createdAt > SESSION_EXPIRE_TIME) {
      console.log(`[Cleanup] Removing expired session: ${sessionId}`);
      sessions.delete(sessionId);
    }
  }
}, 60000); // Check every minute

// ============================================================================
// API ENDPOINTS
// ============================================================================

// Health check
app.get('/health', async (req, res) => {
  try {
    const balanceWei = await web3.eth.getBalance(treasuryAccount.address);
    const balanceBesc = weiToBesc(balanceWei);

    res.json({
      status: 'ok',
      network: 'BESC HYPERCHAIN',
      treasury: treasuryAccount.address,
      balance: parseFloat(balanceBesc),
      requiredDeposit: REQUIRED_DEPOSIT,
      payoutAmount: PAYOUT_AMOUNT,
      activeSessions: sessions.size,
      whitelistedWallets: WHITELISTED_WALLETS.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get treasury balance
app.get('/balance', async (req, res) => {
  try {
    const balanceWei = await web3.eth.getBalance(treasuryAccount.address);
    const balanceBesc = weiToBesc(balanceWei);

    res.json({
      treasury: treasuryAccount.address,
      balance: parseFloat(balanceBesc),
      balanceWei: balanceWei.toString(),
      currency: 'BESC'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// PROFILE MANAGEMENT ENDPOINTS
// ============================================================================

// Get all saved profiles (Dossiers selection grid)
app.get('/profiles', async (req, res) => {
  try {
    let profiles = [];
    if (MONGODB_URI) {
      profiles = await Profile.find({}).sort({ lastSeen: -1 }).limit(30);
    }
    res.json(profiles);
  } catch (err) {
    console.error('[Profiles Fetch] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Create or update a profile
app.post('/profile', async (req, res) => {
  try {
    const { walletAddress, username } = req.body;
    if (!walletAddress || !username) {
      return res.status(400).json({ error: 'walletAddress and username are required' });
    }
    if (!web3.utils.isAddress(walletAddress)) {
      return res.status(400).json({ error: 'Invalid BESC wallet address format' });
    }

    const normalizedAddress = walletAddress.toLowerCase();
    
    let profile = null;
    if (MONGODB_URI) {
      profile = await Profile.findOneAndUpdate(
        { walletAddress: normalizedAddress },
        { username: username },
        { upsert: true, new: true }
      );
      console.log(`[Profile] Saved: ${normalizedAddress} -> ${username}`);
    } else {
      console.log(`[Profile] DB Offline. Simulated save: ${normalizedAddress} -> ${username}`);
    }

    res.json({
      success: true,
      profile: profile || { walletAddress: normalizedAddress, username, hasDeposited: false }
    });
  } catch (err) {
    console.error('[Profile Save] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// DEPOSIT-BASED ACCESS SYSTEM
// ============================================================================

// Step 1: Request access - User submits their wallet address
app.post('/request-access', async (req, res) => {
  try {
    const { walletAddress, wagerTier = 'bronze', gameMode = 'standard' } = req.body;

    if (!walletAddress) {
      return res.status(400).json({ error: 'walletAddress is required' });
    }

    // Validate address format
    if (!web3.utils.isAddress(walletAddress)) {
      return res.status(400).json({ error: 'Invalid BESC wallet address format' });
    }

    const normalizedAddress = walletAddress.toLowerCase();

    // Get tier configuration
    const tier = TIERS[wagerTier.toLowerCase()] ? wagerTier.toLowerCase() : 'bronze';
    const mode = ['standard', 'knife'].includes(gameMode.toLowerCase()) ? gameMode.toLowerCase() : 'standard';

    const requiredDeposit = TIERS[tier].deposit;
    const payoutAmount = TIERS[tier].payout;

    // Check if user already has an active or pending session
    for (const [id, session] of sessions.entries()) {
      if (session.walletAddress === normalizedAddress) {
        if (session.status === 'confirmed' || session.status === 'playing') {
          // If the requested tier matches the active session's tier, we keep the session active
          if (session.wagerTier === tier) {
            // Update game mode if changed
            if (session.gameMode !== mode) {
              session.gameMode = mode;
              console.log(`[Session] Updated game mode for session ${id} to ${mode}`);
            }
            return res.json({
              sessionId: id,
              status: session.status,
              message: 'You already have an active session',
              credits: session.credits,
              wagerTier: session.wagerTier,
              gameMode: session.gameMode
            });
          } else {
            // Requested a different tier: delete old active session to create a new one
            console.log(`[Session] User requested a different tier (${tier} vs active ${session.wagerTier}) for ${normalizedAddress}. Creating new session...`);
            sessions.delete(id);
          }
        } else if (session.status === 'pending') {
          // If pending session parameter changed, delete and recreate
          if (session.wagerTier !== tier || session.gameMode !== mode) {
            console.log(`[Session] User changed pending parameters (${tier}/${mode} vs ${session.wagerTier}/${session.gameMode}) for ${normalizedAddress}. Recreating session...`);
            sessions.delete(id);
          } else {
            // Same parameters: return existing pending session details so they can pay
            return res.json({
              sessionId: id,
              depositAddress: DEPOSIT_ADDRESS,
              requiredAmount: session.requiredDeposit,
              status: session.status,
              credits: session.credits,
              whitelisted: false,
              wagerTier: session.wagerTier,
              gameMode: session.gameMode,
              expiresIn: Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000))
            });
          }
        }
      }
    }

    // Check if wallet is whitelisted
    const whitelisted = isWhitelisted(normalizedAddress);

    // Get current block number to start tracking from
    let startBlockNum = 0;
    if (!whitelisted) {
      try {
        const currentBlock = await web3.eth.getBlockNumber();
        startBlockNum = Number(currentBlock);
      } catch (blockErr) {
        console.error('[Session] Failed to fetch current block number on request-access:', blockErr.message);
      }
    }

    // Create new session
    const sessionId = uuidv4();
    const session = {
      id: sessionId,
      walletAddress: normalizedAddress,
      status: whitelisted ? 'confirmed' : 'pending',
      credits: whitelisted ? 1 : 0,
      totalDeposited: whitelisted ? requiredDeposit : 0,
      depositTxHash: whitelisted ? 'WHITELISTED' : null,
      totalWon: 0,
      wagerTier: tier,
      gameMode: mode,
      requiredDeposit: requiredDeposit,
      payoutAmount: payoutAmount,
      createdBlock: startBlockNum,
      lastCheckedBlock: startBlockNum > 0 ? startBlockNum - 5 : 0,
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_EXPIRE_TIME
    };

    sessions.set(sessionId, session);

    // Ensure profile document exists in MongoDB
    if (MONGODB_URI) {
      try {
        let profile = await Profile.findOne({ walletAddress: normalizedAddress });
        if (!profile) {
          profile = new Profile({
            walletAddress: normalizedAddress,
            username: `Player_${normalizedAddress.substring(2, 6)}`,
            hasDeposited: whitelisted
          });
          await profile.save();
          console.log(`[Profile] Created default profile for new wallet: ${normalizedAddress}`);
        } else {
          let updated = false;
          if (whitelisted && !profile.hasDeposited) {
            profile.hasDeposited = true;
            updated = true;
          }
          profile.lastSeen = Date.now();
          await profile.save();
          if (updated) {
            console.log(`[Profile] Marked whitelisted wallet as deposited in DB: ${normalizedAddress}`);
          }
        }
      } catch (dbErr) {
        console.error('[Session] Database error during profile check:', dbErr.message);
      }
    }

    if (whitelisted) {
      console.log(`[Session] ✅ Created WHITELISTED session ${sessionId} for ${normalizedAddress} (Tier: ${tier}, Mode: ${mode})`);
    } else {
      console.log(`[Session] Created session ${sessionId} for ${normalizedAddress} (Tier: ${tier}, Mode: ${mode})`);
    }

    res.json({
      sessionId,
      depositAddress: DEPOSIT_ADDRESS,
      requiredAmount: requiredDeposit,
      status: session.status,
      credits: session.credits,
      whitelisted: whitelisted,
      wagerTier: tier,
      gameMode: mode,
      expiresIn: SESSION_EXPIRE_TIME / 1000 // seconds
    });
  } catch (err) {
    console.error('[Request Access] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Step 2: Check access status - Poll for deposit confirmation
app.get('/check-access/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found or expired' });
    }

    // If already confirmed, return status
    if (session.status === 'confirmed' || session.status === 'playing') {
      return res.json({
        status: session.status,
        credits: session.credits,
        totalDeposited: session.totalDeposited || 0,
        remainingBalance: parseFloat((session.credits * session.requiredDeposit).toFixed(4)),
        walletAddress: session.walletAddress,
        depositTxHash: session.depositTxHash,
        wagerTier: session.wagerTier,
        gameMode: session.gameMode
      });
    }

    // If still pending, check blockchain for deposit
    if (session.status === 'pending') {
      const depositFound = await checkForDeposit(session);

      if (depositFound.found) {
        // Calculate credits based on amount deposited
        const amountBesc = depositFound.amount;
        const credits = Math.floor(amountBesc / session.requiredDeposit);

        // Update session
        session.status = 'confirmed';
        session.credits = Math.max(1, credits); // At least 1 credit
        session.totalDeposited = amountBesc;
        session.depositTxHash = depositFound.txHash;

        // Mark profile as deposited in MongoDB
        if (MONGODB_URI) {
          Profile.findOneAndUpdate(
            { walletAddress: session.walletAddress },
            { hasDeposited: true, lastSeen: Date.now() },
            { upsert: true }
          ).catch(dbErr => console.error('[Deposit] DB update failed for profile:', dbErr.message));
        }

        console.log(`[Deposit] ✅ Confirmed for ${session.walletAddress} - TX: ${depositFound.txHash} (Amount: ${amountBesc} BESC, Credits: ${session.credits})`);

        return res.json({
          status: 'confirmed',
          credits: session.credits,
          totalDeposited: session.totalDeposited,
          remainingBalance: parseFloat((session.credits * session.requiredDeposit).toFixed(4)),
          walletAddress: session.walletAddress,
          depositTxHash: depositFound.txHash,
          wagerTier: session.wagerTier,
          gameMode: session.gameMode
        });
      }
    }

    // Still pending
    res.json({
      status: 'pending',
      credits: 0,
      message: 'Waiting for deposit...'
    });
  } catch (err) {
    console.error('[Check Access] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Helper function to check blockchain for deposit
async function checkForDeposit(session) {
  try {
    const currentBlock = await web3.eth.getBlockNumber();
    const currentBlockNum = Number(currentBlock);

    // If we don't have block indexes initialized on this session, do a fallback
    const fromBlock = session.lastCheckedBlock ? session.lastCheckedBlock + 1 : (session.createdBlock || currentBlockNum) - 5;

    // If there are no new blocks, return early without querying RPC
    if (fromBlock > currentBlockNum) {
      return { found: false };
    }

    // Capping block scans per check to prevent timeouts on first load or server restart
    const maxBlocksToCheck = 30; // ~90 seconds of history
    const actualFromBlock = Math.max(fromBlock, currentBlockNum - maxBlocksToCheck);

    console.log(`[Check Deposit] Scanning blocks ${actualFromBlock} to ${currentBlockNum} (${currentBlockNum - actualFromBlock + 1} blocks) for wallet ${session.walletAddress}...`);

    // Search recent blocks for transaction from user to treasury
    for (let blockNum = actualFromBlock; blockNum <= currentBlockNum; blockNum++) {
      try {
        const block = await web3.eth.getBlock(blockNum, true);

        if (block && block.transactions) {
          for (const tx of block.transactions) {
            if (tx.from && tx.to &&
                tx.from.toLowerCase() === session.walletAddress.toLowerCase() &&
                tx.to.toLowerCase() === DEPOSIT_ADDRESS) {

              const amountBesc = parseFloat(weiToBesc(tx.value));

              // Check if amount is sufficient (allow ±5% tolerance)
              if (amountBesc >= session.requiredDeposit * 0.95) {
                return { found: true, txHash: tx.hash, amount: amountBesc };
              }
            }
          }
        }
      } catch (blockErr) {
        // Skip blocks that can't be fetched
        continue;
      }
    }

    // Update last checked block so we don't scan them again
    session.lastCheckedBlock = currentBlockNum;
    return { found: false };
  } catch (err) {
    console.error('[Check Deposit] Error:', err);
    return { found: false };
  }
}

// Step 3: Get session info
app.get('/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({
    sessionId: session.id,
    walletAddress: session.walletAddress,
    status: session.status,
    credits: session.credits,
    totalWon: session.totalWon,
    depositTxHash: session.depositTxHash,
    wagerTier: session.wagerTier,
    gameMode: session.gameMode,
    requiredDeposit: session.requiredDeposit,
    totalDeposited: session.totalDeposited || 0,
    remainingBalance: parseFloat((session.credits * session.requiredDeposit).toFixed(4)),
    depositAddress: DEPOSIT_ADDRESS,
    createdAt: session.createdAt
  });
});

// Step 4: Use credit (player dies)
app.post('/session/:sessionId/death', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (session.credits <= 0) {
    session.status = 'dead';
    return res.json({
      status: 'dead',
      credits: 0,
      message: 'No credits remaining. Please deposit again to continue.'
    });
  }

  // Deduct credit
  session.credits -= 1;
  session.status = session.credits > 0 ? 'playing' : 'dead';

  console.log(`[Death] Session ${sessionId} died. Credits remaining: ${session.credits}`);

  res.json({
    status: session.status,
    credits: session.credits,
    message: session.credits > 0 ? 'Respawning...' : 'Game over. Deposit to play again.'
  });
});

// Step 5: Kill reward (send BESC to killer)
app.post('/session/:sessionId/kill-reward', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { victimSessionId } = req.body;

    console.log(`[Kill Reward] 📥 Received reward request - Killer Session: ${sessionId}, Victim Session: ${victimSessionId}`);

    const killerSession = sessions.get(sessionId);

    if (!killerSession) {
      console.log(`[Kill Reward] ❌ Rejected: Killer session not found: ${sessionId}`);
      return res.status(404).json({ error: 'Killer session not found' });
    }

    if (killerSession.status !== 'confirmed' && killerSession.status !== 'playing') {
      console.log(`[Kill Reward] ❌ Rejected: Killer session status is ${killerSession.status} (must be playing/confirmed)`);
      return res.status(400).json({ error: 'Killer session not active' });
    }

    // ===== DUPLICATE PREVENTION =====
    // Check if this killer was already rewarded in the last 3 seconds
    const now = Date.now();
    const lastKillTime = recentKills.get(sessionId);
    const DUPLICATE_WINDOW = 3000; // 3 seconds

    if (lastKillTime && (now - lastKillTime) < DUPLICATE_WINDOW) {
      console.log(`[Kill Reward] ⚠️  Duplicate request blocked for ${sessionId} (within ${DUPLICATE_WINDOW}ms)`);

      // Still return success to avoid client errors
      return res.json({
        success: true,
        transactionHash: 'DUPLICATE_BLOCKED',
        amount: 0,
        totalWon: killerSession.totalWon,
        note: 'Duplicate request blocked'
      });
    }

    // Mark this kill as processed
    recentKills.set(sessionId, now);

    // Clean up old entries (older than 10 seconds)
    for (const [sid, timestamp] of recentKills.entries()) {
      if (now - timestamp > 10000) {
        recentKills.delete(sid);
      }
    }

    const killerWallet = killerSession.walletAddress;
    const payoutAmount = killerSession.payoutAmount || PAYOUT_AMOUNT;

    console.log(`[Kill Reward] Sending ${payoutAmount} BESC to ${killerWallet} (Tier: ${killerSession.wagerTier})`);

    // Check treasury balance
    const balanceWei = await web3.eth.getBalance(treasuryAccount.address);
    const payoutWei = bescToWei(payoutAmount);

    if (BigInt(balanceWei) < BigInt(payoutWei)) {
      console.error('[Kill Reward] Insufficient treasury balance');
      return res.status(400).json({
        success: false,
        error: 'Insufficient treasury balance'
      });
    }

    // Get current gas price
    const gasPrice = await web3.eth.getGasPrice();

    // Create transaction
    const tx = {
      from: treasuryAccount.address,
      to: killerWallet,
      value: payoutWei,
      gas: 21000,
      gasPrice: gasPrice,
    };

    // Send transaction
    let receipt;
    try {
      receipt = await web3.eth.sendTransaction(tx);
    } catch (txError) {
      const errMsg = (txError.message || '').toLowerCase();
      const causeMsg = (txError.cause && txError.cause.message || '').toLowerCase();
      
      // Handle "already known" or "nonce too low" errors (transaction already pending or processed)
      if (errMsg.includes('already known') || errMsg.includes('nonce too low') ||
          causeMsg.includes('already known') || causeMsg.includes('nonce too low')) {
        console.log(`[Kill Reward] ⚠️  Transaction already in mempool or nonce too low (processed/pending), treating as success`);
 
        // Still update session and return success
        killerSession.totalWon += payoutAmount;
        killerSession.status = 'playing';
 
        return res.json({
          success: true,
          transactionHash: 'PENDING',
          amount: payoutAmount,
          totalWon: killerSession.totalWon,
          note: 'Transaction already pending/processed'
        });
      }

      // Re-throw other errors
      throw txError;
    }

    console.log(`[Kill Reward] ✅ Sent ${payoutAmount} BESC - TX: ${receipt.transactionHash}`);

    // Update session
    killerSession.totalWon += payoutAmount;
    killerSession.status = 'playing';

    // Record payment
    const payment = {
      killer: killerWallet,
      killerSessionId: sessionId,
      victimSessionId: victimSessionId || 'unknown',
      amount: payoutAmount,
      transactionHash: receipt.transactionHash,
      timestamp: Date.now(),
    };
    paymentHistory.push(payment);

    res.json({
      success: true,
      transactionHash: receipt.transactionHash,
      amount: payoutAmount,
      totalWon: killerSession.totalWon
    });
  } catch (err) {
    console.error('[Kill Reward] Error:', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// Get payment history
app.get('/payments', (req, res) => {
  res.json({
    total: paymentHistory.length,
    payments: paymentHistory.slice(-20).reverse(), // Last 20 payments
  });
});

// Get all active sessions (for debugging)
app.get('/sessions', (req, res) => {
  const sessionList = Array.from(sessions.values()).map(s => ({
    sessionId: s.id,
    walletAddress: s.walletAddress,
    status: s.status,
    credits: s.credits,
    totalWon: s.totalWon,
    createdAt: new Date(s.createdAt).toISOString()
  }));

  res.json({
    total: sessionList.length,
    sessions: sessionList
  });
});

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, () => {
  console.log(`\n🚀 BESC Game Backend - Deposit-Based Access System`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📍 Network: BESC HYPERCHAIN`);
  console.log(`📍 Treasury: ${treasuryAccount.address}`);
  console.log(`💰 Required Deposit: ${REQUIRED_DEPOSIT} BESC`);
  console.log(`💸 Kill Reward: ${PAYOUT_AMOUNT} BESC`);
  console.log(`⏱️  Session Timeout: ${SESSION_EXPIRE_TIME / 60000} minutes`);
  console.log(`🌐 Server: http://localhost:${PORT}`);

  if (WHITELISTED_WALLETS.length > 0) {
    console.log(`\n✅ Whitelisted Wallets (bypass deposit):`);
    WHITELISTED_WALLETS.forEach((addr, i) => {
      console.log(`   ${i + 1}. ${addr}`);
    });
  }

  console.log(`\n📡 API Endpoints:`);
  console.log(`  POST /request-access           - Create session & get deposit address`);
  console.log(`  GET  /check-access/:sessionId  - Check deposit status`);
  console.log(`  GET  /session/:sessionId       - Get session info`);
  console.log(`  POST /session/:sessionId/death - Deduct credit on death`);
  console.log(`  POST /session/:sessionId/kill-reward - Send BESC reward`);
  console.log(`  GET  /sessions                 - List all active sessions`);
  console.log(`  GET  /payments                 - Payment history`);
  console.log(`  GET  /health                   - Health check`);
  console.log(`  GET  /balance                  - Treasury balance`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
});
