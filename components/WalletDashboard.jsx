'use client'

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { QRCodeSVG } from 'qrcode.react';
import { Scanner } from '@yudiel/react-qr-scanner';
import { MuxedAccount } from '@stellar/stellar-sdk';
import config from '../utils/config';
import { getContractTTLs, getMnemonic, bumpInstanceTTL, bumpCodeTTL, bumpBalanceTTL, bumpFactoryInstanceTTL, bumpFactoryCodeTTL } from '../utils/stellar/index';
import './WalletDashboard.css';

function WalletDashboard({
  publicKey,
  walletAddress,
  balance,
  classicBalance,
  onSendXLM,
  onClassicSend,
  onRefreshBalances,
  onReset,
  onFundAccount,
  onCreateWallet,
  onImportWallet,
  loading,
  creatingWallet,
  lastUpdated,
  gaslessEnabled = false,
}) {
  const [showSend, setShowSend] = useState(false);
  const [showClassicSend, setShowClassicSend] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [showQR, setShowQR] = useState(false);
  const [showClassicQR, setShowClassicQR] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [showClassicScanner, setShowClassicScanner] = useState(false);
  const [showTTLs, setShowTTLs] = useState(false);
  const [ttlData, setTtlData] = useState(null);
  const [loadingTTLs, setLoadingTTLs] = useState(false);
  const [bumpingInstance, setBumpingInstance] = useState(false);
  const [bumpingCode, setBumpingCode] = useState(false);
  const [bumpingBalance, setBumpingBalance] = useState(false);
  const [bumpingFactoryInstance, setBumpingFactoryInstance] = useState(false);
  const [bumpingFactoryCode, setBumpingFactoryCode] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importMnemonic, setImportMnemonic] = useState('');
  const [importError, setImportError] = useState('');
  const [importing, setImporting] = useState(false);
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('');
  const [classicDestination, setClassicDestination] = useState('');
  const [classicAmount, setClassicAmount] = useState('');
  const [destMuxedId, setDestMuxedId] = useState('');
  const [classicDestMuxedId, setClassicDestMuxedId] = useState('');
  const [sending, setSending] = useState(false);
  const [classicSending, setClassicSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [classicSendError, setClassicSendError] = useState('');
  const [useGasless, setUseGasless] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('gasless');
      return saved === 'true';
    }
    return false;
  });
  const [copied, setCopied] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshed, setRefreshed] = useState(false);
  const [funding, setFunding] = useState(false);
  const [funded, setFunded] = useState(false);
  const [muxedId, setMuxedId] = useState('');
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem('theme');
    return saved || 'dark';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem('gasless', useGasless.toString());
  }, [useGasless]);

  // Reset dialog states when walletAddress changes (new wallet created or deleted)
  useEffect(() => {
    setShowSend(false);
    setShowClassicSend(false);
    setShowDelete(false);
    setShowQR(false);
    setShowClassicQR(false);
    setShowScanner(false);
    setShowClassicScanner(false);
    setShowTTLs(false);
    setTtlData(null);
    setShowExport(false);
    setDestination('');
    setAmount('');
    setSending(false);
    setSendError('');
    setClassicSendError('');
    setCopied('');
    setRefreshing(false);
    setRefreshed(false);
    setFunding(false);
    setFunded(false);
  }, [walletAddress]);

  const toggleTheme = (e) => {
    e.preventDefault();
    setTheme(theme === 'dark' ? 'light' : 'dark');
  };

  const shortenAddress = (address) => {
    if (!address || address.length < 12) return address;
    return `${address.substring(0, 6)}....${address.substring(address.length - 6)}`;
  };

  const isValidStellarAddress = (address) => {
    if (!address) return false;
    // G = classic account, C = contract, M = muxed account
    if (!address.match(/^[GCM][A-Z0-9]{55}$/)) return false;
    return true;
  };

  const getClassicReceiveAddress = () => {
    if (!muxedId || muxedId.trim() === '') {
      return publicKey;
    }
    try {
      const muxedAccount = new MuxedAccount(
        { accountId: () => publicKey },
        muxedId.trim()
      );
      return muxedAccount.accountId();
    } catch (e) {
      return publicKey;
    }
  };

  const getMuxedDestination = (dest, muxId) => {
    if (!muxId || muxId.trim() === '' || !dest.startsWith('G')) {
      return dest;
    }
    try {
      const muxedAccount = new MuxedAccount(
        { accountId: () => dest },
        muxId.trim()
      );
      return muxedAccount.accountId();
    } catch (e) {
      return dest;
    }
  };

  const handleRefresh = async (e) => {
    e.preventDefault();
    setRefreshing(true);
    await onRefreshBalances();
    setRefreshing(false);
    setRefreshed(true);
    setTimeout(() => {
      setRefreshed(false);
    }, 2000);
  };

  const handleFund = async (e) => {
    e.preventDefault();
    setFunding(true);
    try {
      await onFundAccount();
      setFunding(false);
      setFunded(true);
      setTimeout(() => setFunded(false), 2000);

      // Refresh balance every second for 5 seconds after funding
      let count = 0;
      const intervalId = setInterval(() => {
        count++;
        onRefreshBalances();
        if (count >= 5) {
          clearInterval(intervalId);
        }
      }, 1000);
    } catch (error) {
      setFunding(false);
      // Error is already logged in parent
    }
  };

  const handleSend = async (e) => {
    e.preventDefault();
    setSendError('');

    // Validate destination address
    if (!isValidStellarAddress(destination)) {
      setSendError('Invalid destination address. Must be a valid G, C, or M address.');
      return;
    }

    // Validate amount
    const amountNum = parseFloat(amount);
    const balanceNum = parseFloat(balance);
    if (isNaN(amountNum) || amountNum <= 0) {
      setSendError('Invalid amount. Must be greater than 0.');
      return;
    }
    if (amountNum > balanceNum) {
      setSendError(`Insufficient balance. Available: ${balance} XLM`);
      return;
    }

    setSending(true);
    try {
      const finalDest = getMuxedDestination(destination, destMuxedId);
      await onSendXLM(finalDest, amount, { gasless: gaslessEnabled && useGasless });
      setDestination('');
      setAmount('');
      setDestMuxedId('');
      setShowSend(false);

      // Refresh balances after successful send
      onRefreshBalances();
    } catch (error) {
      setSendError(error.message || 'Failed to send transaction');
    } finally {
      setSending(false);
    }
  };

  const handleClassicSend = async (e) => {
    e.preventDefault();
    setClassicSendError('');

    // Validate destination address
    if (!isValidStellarAddress(classicDestination)) {
      setClassicSendError('Invalid destination address. Must be a valid G, C, or M address.');
      return;
    }

    // Validate amount
    const amountNum = parseFloat(classicAmount);
    const balanceNum = parseFloat(classicBalance);
    if (isNaN(amountNum) || amountNum <= 0) {
      setClassicSendError('Invalid amount. Must be greater than 0.');
      return;
    }
    if (amountNum > balanceNum) {
      setClassicSendError(`Insufficient balance. Available: ${classicBalance} XLM`);
      return;
    }

    setClassicSending(true);
    try {
      const finalDest = getMuxedDestination(classicDestination, classicDestMuxedId);
      await onClassicSend(finalDest, classicAmount, { gasless: gaslessEnabled && useGasless });
      setClassicDestination('');
      setClassicAmount('');
      setClassicDestMuxedId('');
      setShowClassicSend(false);

      // Refresh balances after successful send
      onRefreshBalances();
    } catch (error) {
      setClassicSendError(error.message || 'Failed to send transaction');
    } finally {
      setClassicSending(false);
    }
  };

  const copyToClipboard = (text, label) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
  };

  const handleScanResult = (result) => {
    if (result && result[0]?.rawValue) {
      setDestination(result[0].rawValue);
      setShowScanner(false);
    }
  };

  const handleClassicScanResult = (result) => {
    if (result && result[0]?.rawValue) {
      setClassicDestination(result[0].rawValue);
      setShowClassicScanner(false);
    }
  };

  const handleShowTTLs = async (e) => {
    e.preventDefault();
    setShowTTLs(true);
    setLoadingTTLs(true);
    setTtlData(null);
    try {
      const data = await getContractTTLs(walletAddress);
      setTtlData(data);
    } catch (error) {
      console.error('Error fetching TTLs:', error);
      setTtlData({ error: error.message });
    } finally {
      setLoadingTTLs(false);
    }
  };

  const refreshTTLs = async () => {
    setLoadingTTLs(true);
    try {
      const data = await getContractTTLs(walletAddress);
      setTtlData(data);
    } catch (error) {
      console.error('Error fetching TTLs:', error);
      setTtlData({ error: error.message });
    } finally {
      setLoadingTTLs(false);
    }
  };

  const handleBumpInstance = async (e) => {
    e.preventDefault();
    setBumpingInstance(true);
    try {
      await bumpInstanceTTL(walletAddress);
      await refreshTTLs();
    } catch (error) {
      console.error('Error bumping instance TTL:', error);
      alert(`Failed to bump instance TTL: ${error.message}`);
    } finally {
      setBumpingInstance(false);
    }
  };

  const handleBumpCode = async (e) => {
    e.preventDefault();
    setBumpingCode(true);
    try {
      await bumpCodeTTL();
      await refreshTTLs();
    } catch (error) {
      console.error('Error bumping code TTL:', error);
      alert(`Failed to bump code TTL: ${error.message}`);
    } finally {
      setBumpingCode(false);
    }
  };

  const handleBumpBalance = async (e) => {
    e.preventDefault();
    setBumpingBalance(true);
    try {
      await bumpBalanceTTL(walletAddress);
      await refreshTTLs();
    } catch (error) {
      console.error('Error bumping balance TTL:', error);
      alert(`Failed to bump balance TTL: ${error.message}`);
    } finally {
      setBumpingBalance(false);
    }
  };

  const handleBumpFactoryInstance = async (e) => {
    e.preventDefault();
    setBumpingFactoryInstance(true);
    try {
      await bumpFactoryInstanceTTL();
      await refreshTTLs();
    } catch (error) {
      console.error('Error bumping factory instance TTL:', error);
      alert(`Failed to bump factory instance TTL: ${error.message}`);
    } finally {
      setBumpingFactoryInstance(false);
    }
  };

  const handleBumpFactoryCode = async (e) => {
    e.preventDefault();
    setBumpingFactoryCode(true);
    try {
      await bumpFactoryCodeTTL();
      await refreshTTLs();
    } catch (error) {
      console.error('Error bumping factory code TTL:', error);
      alert(`Failed to bump factory code TTL: ${error.message}`);
    } finally {
      setBumpingFactoryCode(false);
    }
  };

  const handleImport = async (e) => {
    e.preventDefault();
    setImportError('');
    setImporting(true);
    try {
      await onImportWallet(importMnemonic);
      setShowImport(false);
      setImportMnemonic('');
    } catch (error) {
      setImportError(error.message);
    } finally {
      setImporting(false);
    }
  };

  // Show generate wallet link if no wallet exists
  if (!walletAddress) {
    return (
      <div className="wallet-dashboard">
        <h1>LUMENITOS</h1>
        <p className={`network-label ${config.isTestnet ? 'testnet' : 'mainnet'}`}>
          {config.isTestnet ? config.stellar.network : 'MAINNET - FUNDS AT RISK'}
        </p>
        <p className="disclaimer">THIS IS AN EXPERIMENTAL STELLAR SMART WALLET. DON'T BE STUPID.</p>

        <hr />

        <p>
          <a href="#" onClick={(e) => { e.preventDefault(); onCreateWallet(); }}>
            {creatingWallet ? 'loading...' : 'generate wallet'}
          </a>
          {' | '}
          <a href="#" onClick={(e) => { e.preventDefault(); setShowImport(true); }}>
            import
          </a>
        </p>

        {showImport && (
          <div className="modal-overlay" onClick={() => !importing && setShowImport(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h3>import wallet</h3>

              <p>enter your 12-word recovery phrase to restore your wallet.</p>

              <form onSubmit={handleImport}>
                <div className="form-group">
                  <label htmlFor="importMnemonic">recovery phrase</label>
                  <textarea
                    id="importMnemonic"
                    value={importMnemonic}
                    onChange={(e) => setImportMnemonic(e.target.value)}
                    placeholder="word1 word2 word3 ..."
                    rows={3}
                    required
                    disabled={importing}
                  />
                </div>

                {importError && (
                  <p className="error">{importError}</p>
                )}

                <p>
                  <a href="#" onClick={(e) => { e.preventDefault(); setShowImport(false); setImportError(''); setImportMnemonic(''); }}>cancel</a>
                  {' | '}
                  <a href="#" onClick={handleImport}>
                    {importing ? 'importing...' : 'import'}
                  </a>
                </p>
              </form>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="wallet-dashboard">
      <h1>LUMENITOS</h1>
      <p className={`network-label ${config.isTestnet ? 'testnet' : 'mainnet'}`}>
        {config.isTestnet ? config.stellar.network : 'MAINNET - FUNDS AT RISK'}
      </p>
      <p className="disclaimer">THIS IS AN EXPERIMENTAL STELLAR SMART WALLET. DON'T BE STUPID.</p>

      {config.isTestnet && parseFloat(balance) === 0 && parseFloat(classicBalance) === 0 && (
        <p>
          <a href="#" onClick={handleFund}>
            {funding ? 'funding' : funded ? 'funded!' : 'fund'}
          </a>
        </p>
      )}

      <hr />

      <p>
      {shortenAddress(publicKey)}{' '}
        (<a href="#" onClick={(e) => { e.preventDefault(); copyToClipboard(publicKey, 'classic'); }}>
          {copied === 'classic' ? 'copied!' : 'copy'}
        </a>)
      </p>

      <p>
        {classicBalance} XLM
      </p>

      <p>
        <a href="#" onClick={(e) => { e.preventDefault(); setShowClassicQR(true); }}>receive</a>
        {' | '}
        <a href="#" onClick={(e) => { e.preventDefault(); setShowClassicSend(true); }}>send</a>
        {' | '}
        <Link href={`/scan/account/${publicKey}`}>scan</Link>
      </p>

      <hr />

      <p>
      {shortenAddress(walletAddress)}{' '}
        (<a href="#" onClick={(e) => { e.preventDefault(); copyToClipboard(walletAddress, 'contract'); }}>
          {copied === 'contract' ? 'copied!' : 'copy'}
        </a>)
      </p>

      <p>
        {balance} XLM
      </p>

      <p>
        <a href="#" onClick={(e) => { e.preventDefault(); setShowQR(true); }}>receive</a>
        {' | '}
        <a href="#" onClick={(e) => { e.preventDefault(); setShowSend(true); }}>send</a>
        {' | '}
        <Link href={`/scan/account/${walletAddress}`}>scan</Link>
        {' | '}
        <a href="#" onClick={handleShowTTLs}>ttls</a>
      </p>

      <hr />

      {gaslessEnabled && (
        <p>
          <label>
            <input
              type="checkbox"
              checked={useGasless}
              onChange={(e) => setUseGasless(e.target.checked)}
            />
            {' '}use oz channels
          </label>
        </p>
      )}

      {lastUpdated && (
        <p>
          updated: {new Date(lastUpdated).toLocaleString()}
        </p>
      )}

      <p>
        <a href="#" onClick={handleRefresh}>
          {refreshing ? 'refreshing' : refreshed ? 'refreshed!' : 'refresh'}
        </a>
        {' | '}
        <a href="#" onClick={(e) => { e.preventDefault(); setShowExport(true); }}>export</a>
        {' | '}
        <a href="#" onClick={(e) => { e.preventDefault(); setShowDelete(true); }}>forget</a>
      </p>

      <div className="theme-toggle">
        <a href="#" onClick={toggleTheme}>
          {theme === 'dark' ? 'bright' : 'dark'}
        </a>
      </div>

      {showClassicSend && (
        <div className="modal-overlay" onClick={() => !classicSending && setShowClassicSend(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>send xlm (classic account)</h3>

            <form onSubmit={handleClassicSend}>
              <div className="form-group">
                <label htmlFor="classicDestination">
                  destination address (<a href="#" onClick={(e) => { e.preventDefault(); setShowClassicScanner(true); }}>qr</a>)
                </label>
                <input
                  type="text"
                  id="classicDestination"
                  value={classicDestination}
                  onChange={(e) => { setClassicDestination(e.target.value); setClassicSendError(''); }}
                  placeholder="GXXX... or CXXX..."
                  required
                  disabled={classicSending}
                />
              </div>

              <div className="form-group">
                <label htmlFor="classicDestMuxedId">muxed id (optional)</label>
                <input
                  type="text"
                  id="classicDestMuxedId"
                  value={classicDestMuxedId}
                  onChange={(e) => setClassicDestMuxedId(e.target.value)}
                  placeholder="e.g. 12345"
                  disabled={classicSending || !classicDestination.startsWith('G')}
                />
              </div>

              <div className="form-group">
                <label htmlFor="classicAmount">amount (xlm)</label>
                <input
                  type="number"
                  id="classicAmount"
                  value={classicAmount}
                  onChange={(e) => { setClassicAmount(e.target.value); setClassicSendError(''); }}
                  placeholder="0.00"
                  step="0.0000001"
                  min="0.0000001"
                  max={classicBalance}
                  required
                  disabled={classicSending}
                />
                <small>available: {classicBalance} xlm</small>
              </div>

              {classicSendError && (
                <p className="error">{classicSendError}</p>
              )}

              <p>
                <a href="#" onClick={(e) => { e.preventDefault(); setShowClassicSend(false); setClassicSendError(''); }}>cancel</a>
                {' | '}
                <a href="#" onClick={(e) => { e.preventDefault(); handleClassicSend(e); }}>
                  {classicSending ? 'sending...' : 'send'}
                </a>
              </p>
            </form>
          </div>
        </div>
      )}

      {showSend && (
        <div className="modal-overlay" onClick={() => !sending && setShowSend(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>send xlm (contract account)</h3>

            <form onSubmit={handleSend}>
              <div className="form-group">
                <label htmlFor="destination">
                  destination address (<a href="#" onClick={(e) => { e.preventDefault(); setShowScanner(true); }}>qr</a>)
                </label>
                <input
                  type="text"
                  id="destination"
                  value={destination}
                  onChange={(e) => { setDestination(e.target.value); setSendError(''); }}
                  placeholder="GXXX..."
                  required
                  disabled={sending}
                />
              </div>

              <div className="form-group">
                <label htmlFor="destMuxedId">muxed id (optional)</label>
                <input
                  type="text"
                  id="destMuxedId"
                  value={destMuxedId}
                  onChange={(e) => setDestMuxedId(e.target.value)}
                  placeholder="e.g. 12345"
                  disabled={sending || !destination.startsWith('G')}
                />
              </div>

              <div className="form-group">
                <label htmlFor="amount">amount (xlm)</label>
                <input
                  type="number"
                  id="amount"
                  value={amount}
                  onChange={(e) => { setAmount(e.target.value); setSendError(''); }}
                  placeholder="0.00"
                  step="0.0000001"
                  min="0.0000001"
                  max={balance}
                  required
                  disabled={sending}
                />
                <small>available: {balance} xlm</small>
              </div>

              {sendError && (
                <p className="error">{sendError}</p>
              )}

              <p>
                <a href="#" onClick={(e) => { e.preventDefault(); setShowSend(false); setSendError(''); }}>cancel</a>
                {' | '}
                <a href="#" onClick={(e) => { e.preventDefault(); handleSend(e); }}>
                  {sending ? 'sending...' : 'send'}
                </a>
              </p>
            </form>
          </div>
        </div>
      )}

      {showDelete && (
        <div className="modal-overlay" onClick={() => setShowDelete(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>forget wallet</h3>

            <p>are you sure you want to forget your wallet? this will permanently delete your keys!</p>

            <p>
              <a href="#" onClick={(e) => { e.preventDefault(); setShowDelete(false); }}>cancel</a>
              {' | '}
              <a href="#" onClick={(e) => { e.preventDefault(); onReset(); }}>forget</a>
            </p>
          </div>
        </div>
      )}

      {showQR && (
        <div className="modal-overlay" onClick={() => setShowQR(false)}>
          <div className="modal qr-modal" onClick={(e) => e.stopPropagation()}>
            <div className="qr-code-container">
              <QRCodeSVG value={walletAddress} size={256} />
            </div>

            <p className="qr-address">{walletAddress}</p>

            <p>
              <a href="#" onClick={(e) => { e.preventDefault(); setShowQR(false); }}>close</a>
            </p>
          </div>
        </div>
      )}

      {showClassicQR && (
        <div className="modal-overlay" onClick={() => setShowClassicQR(false)}>
          <div className="modal qr-modal" onClick={(e) => e.stopPropagation()}>
            <div className="form-group">
              <label htmlFor="muxedId">muxed id (optional)</label>
              <input
                type="text"
                id="muxedId"
                value={muxedId}
                onChange={(e) => setMuxedId(e.target.value)}
                placeholder="e.g. 12345"
              />
            </div>

            <div className="qr-code-container">
              <QRCodeSVG value={getClassicReceiveAddress()} size={256} />
            </div>

            <p className="qr-address">{getClassicReceiveAddress()}</p>

            <p>
              <a href="#" onClick={(e) => { e.preventDefault(); copyToClipboard(getClassicReceiveAddress(), 'receive'); }}>
                {copied === 'receive' ? 'copied!' : 'copy'}
              </a>
              {' | '}
              <a href="#" onClick={(e) => { e.preventDefault(); setShowClassicQR(false); }}>close</a>
            </p>
          </div>
        </div>
      )}

      {showScanner && (
        <div className="modal-overlay" onClick={() => setShowScanner(false)}>
          <div className="modal scanner-modal" onClick={(e) => e.stopPropagation()}>
            <Scanner onScan={handleScanResult} sound={false} />
            <p>
              <a href="#" onClick={(e) => { e.preventDefault(); setShowScanner(false); }}>cancel</a>
            </p>
          </div>
        </div>
      )}

      {showClassicScanner && (
        <div className="modal-overlay" onClick={() => setShowClassicScanner(false)}>
          <div className="modal scanner-modal" onClick={(e) => e.stopPropagation()}>
            <Scanner onScan={handleClassicScanResult} sound={false} />
            <p>
              <a href="#" onClick={(e) => { e.preventDefault(); setShowClassicScanner(false); }}>cancel</a>
            </p>
          </div>
        </div>
      )}

      {showTTLs && (
        <div className="modal-overlay" onClick={() => setShowTTLs(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>contract ttls</h3>

            {loadingTTLs ? (
              <p>loading...</p>
            ) : ttlData?.error ? (
              <p>error: {ttlData.error}</p>
            ) : ttlData ? (
              <>
                <p>current ledger: {ttlData.currentLedger}</p>
                <p>
                  account instance: {ttlData.instance || 'n/a'}
                  {ttlData.instance && (
                    <><br />{ttlData.instance - ttlData.currentLedger} remaining (<a href="#" onClick={handleBumpInstance}>{bumpingInstance ? 'bumping...' : 'bump'}</a>)</>
                  )}
                </p>
                <p>
                  account code (wasm): {ttlData.code || 'n/a'}
                  {ttlData.code && (
                    <><br />{ttlData.code - ttlData.currentLedger} remaining (<a href="#" onClick={handleBumpCode}>{bumpingCode ? 'bumping...' : 'bump'}</a>)</>
                  )}
                </p>
                <p>
                  xlm balance: {ttlData.balance || 'n/a'}
                  {ttlData.balance && (
                    <><br />{ttlData.balance - ttlData.currentLedger} remaining (<a href="#" onClick={handleBumpBalance}>{bumpingBalance ? 'bumping...' : 'bump'}</a>)</>
                  )}
                </p>
                <p>
                  factory instance: {ttlData.factoryInstance || 'n/a'}
                  {ttlData.factoryInstance && (
                    <><br />{ttlData.factoryInstance - ttlData.currentLedger} remaining (<a href="#" onClick={handleBumpFactoryInstance}>{bumpingFactoryInstance ? 'bumping...' : 'bump'}</a>)</>
                  )}
                </p>
                <p>
                  factory code (wasm): {ttlData.factoryCode || 'n/a'}
                  {ttlData.factoryCode && (
                    <><br />{ttlData.factoryCode - ttlData.currentLedger} remaining (<a href="#" onClick={handleBumpFactoryCode}>{bumpingFactoryCode ? 'bumping...' : 'bump'}</a>)</>
                  )}
                </p>
              </>
            ) : null}

            <p>
              <a href="#" onClick={(e) => { e.preventDefault(); setShowTTLs(false); }}>close</a>
            </p>
          </div>
        </div>
      )}

      {showExport && (
        <div className="modal-overlay" onClick={() => setShowExport(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>recovery phrase</h3>

            <p className="warning">write these 12 words down and store them safely. anyone with this phrase can access your wallet.</p>

            {(() => {
              const mnemonic = getMnemonic();
              if (!mnemonic) {
                return <p>no recovery phrase available (wallet created before mnemonic support)</p>;
              }
              const words = mnemonic.split(' ');
              return (
                <>
                  <div className="mnemonic-grid">
                    {words.map((word, index) => (
                      <div key={index} className="mnemonic-word">
                        <span className="word-number">{index + 1}.</span> {word}
                      </div>
                    ))}
                  </div>
                  <p>
                    <a href="#" onClick={(e) => { e.preventDefault(); copyToClipboard(mnemonic, 'mnemonic'); }}>
                      {copied === 'mnemonic' ? 'copied!' : 'copy (unsafe!)'}
                    </a>
                    {' | '}
                    <a href="#" onClick={(e) => { e.preventDefault(); setShowExport(false); }}>close</a>
                  </p>
                </>
              );
            })()}

            {!getMnemonic() && (
              <p>
                <a href="#" onClick={(e) => { e.preventDefault(); setShowExport(false); }}>close</a>
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default WalletDashboard;
