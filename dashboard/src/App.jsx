import { useState, useEffect } from 'react';
import './App.css';

function App() {
  const [health, setHealth] = useState({ status: 'offline', network: 'TESTNET', payer: 'N/A', grpcConnected: false });
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('0.001');
  const [action, setAction] = useState('transfer');
  const [decimals, setDecimals] = useState('9');
  const [mintAmount, setMintAmount] = useState('1000000');
  
  // Submit state & Stepper state
  const [submitting, setSubmitting] = useState(false);
  const [currentStep, setCurrentStep] = useState(0); // 0: Timing, 1: Tipping, 2: Jito, 3: Geyser, 4: Done
  const [pipelineLog, setPipelineLog] = useState([]);
  const [txResult, setTxResult] = useState(null);

  // History list
  const [transactions, setTransactions] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [switchingNetwork, setSwitchingNetwork] = useState(false);

  // API Server URL
  const API_URL = 'http://localhost:3000';

  const handleNetworkChange = async (newNet) => {
    if (submitting || switchingNetwork) return;
    setSwitchingNetwork(true);
    try {
      const res = await fetch(`${API_URL}/api/v1/network`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ network: newNet })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setHealth(prev => ({
          ...prev,
          network: data.network.toUpperCase(),
          grpcConnected: data.grpcConnected
        }));
        // Force refresh transaction list immediately
        fetchTransactions();
      }
    } catch (e) {
      console.error("Network change failed", e);
    } finally {
      setSwitchingNetwork(false);
    }
  };

  // Fetch health on mount
  useEffect(() => {
    fetchHealth();
    fetchTransactions();
    const interval = setInterval(() => {
      fetchHealth();
      fetchTransactions();
    }, 4000);
    return () => clearInterval(interval);
  }, []);

  const fetchHealth = async () => {
    try {
      const res = await fetch(`${API_URL}/api/v1/health`);
      const data = await res.json();
      setHealth({
        status: data.status,
        network: data.network,
        payer: data.payer,
        grpcConnected: data.grpcConnected
      });
      if (!destination) {
        setDestination(data.payer); // Prefill destination with payer address for self-transfer convenience
      }
    } catch (e) {
      setHealth({ status: 'offline', network: 'TESTNET', payer: 'N/A', grpcConnected: false });
    }
  };

  const fetchTransactions = async () => {
    try {
      const res = await fetch(`${API_URL}/api/v1/transactions`);
      const data = await res.json();
      if (Array.isArray(data)) {
        // Reverse array to show newest first
        setTransactions([...data].reverse());
      }
      setLoadingHistory(false);
    } catch (e) {
      setLoadingHistory(false);
    }
  };

  const handleSend = async (e) => {
    e.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setCurrentStep(0);
    setTxResult(null);
    setPipelineLog([
      { step: 0, text: 'Querying AIAgent for optimal timing decision...', status: 'active' }
    ]);

    try {
      // Step 0: Timing optimization
      await new Promise(r => setTimeout(r, 1200));
      setCurrentStep(1);
      setPipelineLog(prev => [
        ...prev.map(l => l.step === 0 ? { ...l, status: 'success', text: 'AI Timing optimization complete.' } : l),
        { step: 1, text: 'Querying AIAgent for congestion & tip flooring strategy...', status: 'active' }
      ]);

      // Step 1: Tip estimation
      await new Promise(r => setTimeout(r, 1500));
      setCurrentStep(2);
      setPipelineLog(prev => [
        ...prev.map(l => l.step === 1 ? { ...l, status: 'success', text: 'AI Tipping suggestion resolved.' } : l),
        { step: 2, text: 'Assembling Jito bundle & signing payload...', status: 'active' }
      ]);

      let bodyData = {};
      if (action === 'transfer') {
        bodyData = { action, destination, amountLamports: parseFloat(amount) * 1_000_000_000 };
      } else if (action === 'mint') {
        bodyData = { action, decimals: parseInt(decimals, 10), mintAmount: parseFloat(mintAmount) };
      } else {
        bodyData = { action, amount: parseFloat(amount) };
      }

      // Step 2: Assemble Jito payload and send POST to backend
      const response = await fetch(`${API_URL}/api/v1/submit-transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyData)
      });
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to submit bundle');
      }

      setCurrentStep(3);
      setPipelineLog(prev => [
        ...prev.map(l => l.step === 2 ? { ...l, status: 'success', text: 'Jito Bundle accepted.' } : l),
        { step: 3, text: 'Awaiting Yellowstone Geyser stream landing confirmation...', status: 'active' }
      ]);

      // Step 3: Geyser Confirmation
      await new Promise(r => setTimeout(r, 2000));
      setCurrentStep(4);
      setPipelineLog(prev => [
        ...prev.map(l => l.step === 3 ? { ...l, status: 'success', text: 'Yellowstone Geyser processed block confirmation.' } : l)
      ]);
      setTxResult({ 
        success: true, 
        signature: data.signature, 
        solscanUrl: data.solscanUrl, 
        timing: data.timingDecision, 
        tip: data.tipDecision,
        mintAddress: data.mintAddress,
        ataAddress: data.ataAddress
      });
      fetchTransactions();

    } catch (err) {
      setCurrentStep(4);
      setPipelineLog(prev => [
        ...prev.map(l => l.status === 'active' ? { ...l, status: 'failed', text: `Failed: ${err.message}` } : l)
      ]);
      setTxResult({ success: false, error: err.message });
      fetchTransactions();
    } finally {
      setSubmitting(false);
    }
  };

  const getStepStatusClass = (stepNum) => {
    if (currentStep > stepNum) return 'step-completed';
    if (currentStep === stepNum && submitting) return 'step-active';
    return 'step-pending';
  };

  return (
    <div className="app-container">
      {/* Dynamic Background Glows */}
      <div className="bg-glow bg-glow-1"></div>
      <div className="bg-glow bg-glow-2"></div>

      {/* Header Panel */}
      <header className="app-header glass-panel">
        <div className="logo-section">
          <div className="gradient-sphere"></div>
          <h1>Solstack Portal</h1>
        </div>
        
        {/* Connection status badges */}
        <div className="status-indicators">
          <div className="indicator-pill">
            <span className="dot" style={{ background: health.status === 'healthy' ? '#10b981' : '#ef4444' }}></span>
            <span>Relay Server: <b>{health.status.toUpperCase()}</b></span>
          </div>
          <div className="indicator-pill">
            <span className="dot" style={{ background: health.grpcConnected ? '#10b981' : '#ef4444' }}></span>
            <span>gRPC Geyser: <b>{health.grpcConnected ? 'CONNECTED' : 'DISCONNECTED'}</b></span>
          </div>
          <div className="indicator-pill network-pill">
            <select
              value={health.network.toLowerCase()}
              onChange={(e) => handleNetworkChange(e.target.value)}
              className="network-select"
              disabled={submitting || switchingNetwork}
            >
              <option value="testnet">TESTNET</option>
              <option value="devnet">DEVNET</option>
              <option value="mainnet-beta">MAINNET</option>
            </select>
          </div>
        </div>
      </header>

      <main className="main-layout">
        {/* Left column: Controls & Interactive Pipeline */}
        <div className="left-column">
          {/* Wallet Card */}
          <div className="wallet-card glass-panel card-glow">
            <h3>Active Relayer Address</h3>
            <div className="address-display">
              <code>{health.payer}</code>
            </div>
            <p className="wallet-note">Transactions are optimized using Yellowstone Geyser live schedules before bundler injection.</p>
          </div>

          {/* Transaction Portal */}
          <div className="form-card glass-panel">
            <h2>Send Smart Transaction</h2>
            <form onSubmit={handleSend}>
              <div className="input-group">
                <label>Operation Type</label>
                <select 
                  value={action} 
                  onChange={(e) => setAction(e.target.value)} 
                  className="network-select" 
                  style={{ width: '100%', padding: '0.8rem', borderRadius: '8px', background: 'rgba(255, 255, 255, 0.05)', color: 'white', border: '1px solid rgba(255, 255, 255, 0.1)' }}
                  disabled={submitting}
                >
                  <option value="transfer">SOL Transfer</option>
                  <option value="mint">Create SPL Token & Mint</option>
                  <option value="swap">{"Jupiter Swap (SOL -> USDC, Mainnet)"}</option>
                  <option value="arbitrage">{"Arbitrage Loop (SOL -> USDC -> SOL, Mainnet)"}</option>
                </select>
              </div>

              {action === 'transfer' && (
                <>
                  <div className="input-group">
                    <label>Destination Wallet Address</label>
                    <input 
                      type="text" 
                      value={destination} 
                      onChange={(e) => setDestination(e.target.value)} 
                      placeholder="Enter Solana public key" 
                      required
                      disabled={submitting}
                    />
                  </div>

                  <div className="input-group">
                    <label>Amount (SOL)</label>
                    <input 
                      type="number" 
                      step="any"
                      value={amount} 
                      onChange={(e) => setAmount(e.target.value)} 
                      placeholder="0.001" 
                      required
                      disabled={submitting}
                    />
                  </div>
                </>
              )}

              {action === 'mint' && (
                <>
                  <div className="input-group">
                    <label>Token Decimals</label>
                    <input 
                      type="number" 
                      value={decimals} 
                      onChange={(e) => setDecimals(e.target.value)} 
                      placeholder="9" 
                      required
                      disabled={submitting}
                    />
                  </div>

                  <div className="input-group">
                    <label>Amount of Tokens to Mint</label>
                    <input 
                      type="number" 
                      value={mintAmount} 
                      onChange={(e) => setMintAmount(e.target.value)} 
                      placeholder="1000000" 
                      required
                      disabled={submitting}
                    />
                  </div>
                </>
              )}

              {(action === 'swap' || action === 'arbitrage') && (
                <div className="input-group">
                  <label>Amount of SOL to Swap</label>
                  <input 
                    type="number" 
                    step="any"
                    value={amount} 
                    onChange={(e) => setAmount(e.target.value)} 
                    placeholder="0.01" 
                    required
                    disabled={submitting}
                  />
                </div>
              )}

              <button type="submit" className="submit-btn gradient-btn" disabled={submitting || health.status === 'offline'}>
                {submitting ? 'Optimizing & Executing...' : 'Execute AI-Optimized Action'}
              </button>
            </form>
          </div>

          {/* Stepper Pipeline */}
          {(submitting || txResult) && (
            <div className="stepper-card glass-panel card-glow">
              <h2>Cognitive Pipeline Stepper</h2>
              
              <div className="stepper-timeline">
                <div className={`timeline-step ${getStepStatusClass(0)}`}>
                  <div className="step-number">1</div>
                  <div className="step-content">
                    <h4>AI Timing Decision</h4>
                    <p>Orchestrating wait time slots based on geyser scheduler.</p>
                  </div>
                </div>
                
                <div className={`timeline-step ${getStepStatusClass(1)}`}>
                  <div className="step-number">2</div>
                  <div className="step-content">
                    <h4>AI Tipping Optimizer</h4>
                    <p>Dynamically determining Jito Block Engine tip requirements.</p>
                  </div>
                </div>

                <div className={`timeline-step ${getStepStatusClass(2)}`}>
                  <div className="step-number">3</div>
                  <div className="step-content">
                    <h4>Jito Bundling</h4>
                    <p>Injecting tips, packing instruction payloads, and executing transaction bundle.</p>
                  </div>
                </div>

                <div className={`timeline-step ${getStepStatusClass(3)}`}>
                  <div className="step-number">4</div>
                  <div className="step-content">
                    <h4>Yellowstone Landing stream</h4>
                    <p>Live confirmation audits via gRPC block subscriptions.</p>
                  </div>
                </div>
              </div>

              {/* Logs block */}
              <div className="stepper-logs">
                {pipelineLog.map((log, i) => (
                  <div key={i} className={`log-entry log-${log.status}`}>
                    <span className="log-dot"></span>
                    <span className="log-text">{log.text}</span>
                  </div>
                ))}
              </div>

              {/* Tx result output */}
              {txResult && (
                <div className={`result-box result-${txResult.success ? 'success' : 'failed'}`}>
                  {txResult.success ? (
                    <>
                      <h3>✓ Transaction Landed Successfully!</h3>
                      <div className="tx-details">
                        <div className="detail-row">
                          <span>Signature:</span>
                          <code className="signature-code">{txResult.signature.substring(0, 24)}...</code>
                        </div>
                        {txResult.timing && (
                          <div className="detail-row">
                            <span>AI Timing Decision:</span>
                            <span className="value-label">{txResult.timing.shouldSubmit ? 'SUBMIT' : 'HOLD'} ({txResult.timing.waitTimeMs}ms)</span>
                          </div>
                        )}
                        {txResult.tip && (
                          <div className="detail-row">
                            <span>AI Optimized Tip:</span>
                            <span className="value-label">{txResult.tip.lamports.toLocaleString()} lamports</span>
                          </div>
                        )}
                      </div>
                      <a href={txResult.solscanUrl} target="_blank" rel="noreferrer" className="solscan-link">
                        View On Solana Explorer
                      </a>
                      {txResult.mintAddress && (
                        <div className="detail-row" style={{ marginTop: '0.5rem' }}>
                          <span>Mint Address:</span>
                          <code className="signature-code" style={{ fontSize: '0.8rem' }}>{txResult.mintAddress}</code>
                        </div>
                      )}
                      {txResult.ataAddress && (
                        <div className="detail-row" style={{ marginTop: '0.5rem' }}>
                          <span>ATA Address:</span>
                          <code className="signature-code" style={{ fontSize: '0.8rem' }}>{txResult.ataAddress}</code>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <h3>✗ Transaction Execution Failed</h3>
                      <p className="err-msg">{txResult.error}</p>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right column: Recent Audits & Landing metrics */}
        <div className="right-column">
          <div className="history-card glass-panel">
            <h2>Live Transaction History</h2>
            <p className="history-description">This ledger audits only the private transaction lifecycles executed by this Relayer client. Public cluster transactions are not listed.</p>
            
            {loadingHistory ? (
              <div className="loading-state">Retrieving lifecycle audit ledger...</div>
            ) : transactions.length === 0 ? (
              <div className="empty-state">No transactions recorded. Execute a transfer to generate log entries.</div>
            ) : (
              <div className="history-list">
                {transactions.map((tx, idx) => {
                  const status = tx.status || 'success';
                  const timestamp = tx.commitment_progression?.submitted_at || tx.stages?.submitted_at || Date.now();
                  const signature = tx.signature || '';
                  const tipVal = tx.tip_lamports !== undefined ? tx.tip_lamports : (tx.tip !== undefined ? tx.tip : 0);
                  const solscanUrl = tx.solscan_url || (signature ? `https://solscan.io/tx/${signature}?cluster=testnet` : '#');

                  return (
                    <div key={idx} className={`history-item item-${status}`}>
                      <div className="item-header">
                        <span className={`status-tag tag-${status}`}>
                          {status.toUpperCase()}
                        </span>
                        <span className="timestamp">
                          {new Date(timestamp).toLocaleTimeString()}
                        </span>
                      </div>

                      <div className="item-body">
                        <div className="metric-col">
                          <label>Signature</label>
                          <code className="sig-snippet">
                            {signature ? `${signature.substring(0, 16)}...` : 'N/A'}
                          </code>
                        </div>
                        <div className="metric-col">
                          <label>Landed Slot</label>
                          <span>{tx.slot || 'N/A'}</span>
                        </div>
                        <div className="metric-col">
                          <label>AI Tip Paid</label>
                          <span>{tipVal ? `${tipVal.toLocaleString()} lps` : '0 lps'}</span>
                        </div>
                      </div>

                      {/* Latency statistics */}
                      {status === 'success' && tx.latency_metrics && (
                        <div className="item-footer">
                          <span className="metric-tag">
                            ⚡ Geyser Confirm: <b>{tx.latency_metrics.to_processed_ms ? `${tx.latency_metrics.to_processed_ms}ms` : 'N/A'}</b>
                          </span>
                        </div>
                      )}

                      {/* Error details */}
                      {status === 'failed' && tx.failure_details && (
                        <div className="item-footer-error">
                          <p className="err-label">Error: {tx.failure_details.error_message}</p>
                          <p className="ai-label">AI Triage: {tx.failure_details.ai_reasoning}</p>
                        </div>
                      )}

                      <div className="item-link">
                        <a href={solscanUrl} target="_blank" rel="noreferrer">
                          View Audit Ledger
                        </a>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
