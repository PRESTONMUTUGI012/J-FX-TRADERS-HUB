class DerivAPIConnector {
    constructor(numericAppId = "1089") {
        this.appId = /^\d+$/.test(String(numericAppId)) ? String(numericAppId) : "1089";
        this.ws = null;
        this.isConnected = false;
        this.isAuthorized = false;
        this.liveWsReceiving = {};
        this.activeToken = null;
        this.accounts = [];
        this.subscribers = {};
        this.multiSubscribers = {};
        this.fallbackInterval = null;
        this.simPrices = {};
        this.onBalanceUpdate = null;
        this.onContractPurchased = null;
    }

    extractOAuthTokensFromUrl() {
        const params = new URLSearchParams(window.location.search);
        const accounts = [];
        let i = 1;
        while (params.has(`acct${i}`) && params.has(`token${i}`)) {
            const acct = params.get(`acct${i}`);
            const token = params.get(`token${i}`);
            const cur = params.get(`cur${i}`) || "USD";
            const isVirtual = acct.startsWith("VRTC");
            accounts.push({ account: acct, token: token, currency: cur, isVirtual });
            i++;
        }
        if (accounts.length > 0) {
            this.accounts = accounts;
            localStorage.setItem("elhadart_deriv_accounts", JSON.stringify(accounts));
            window.history.replaceState({}, document.title, window.location.pathname);
        } else {
            const saved = localStorage.getItem("elhadart_deriv_accounts");
            if (saved) {
                try { this.accounts = JSON.parse(saved); } catch (e) {}
            }
        }
        return this.accounts;
    }

    connect() {
        this.extractOAuthTokensFromUrl();
        this.startHybridFallback();
        return new Promise((resolve) => {
            const endpoint = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
            try {
                this.ws = new WebSocket(endpoint);
            } catch (e) {
                resolve(true);
                return;
            }

            this.ws.onopen = () => {
                this.isConnected = true;
                if (this.accounts.length > 0) {
                    const demoAcc = this.accounts.find(a => a.isVirtual) || this.accounts[0];
                    this.authorize(demoAcc.token);
                }
            };

            this.ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.msg_type === 'authorize' && data.authorize) {
                        this.isAuthorized = true;
                        this.ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
                        if (this.onBalanceUpdate) {
                            this.onBalanceUpdate({ balance: data.authorize.balance, loginid: data.authorize.loginid });
                        }
                    } else if (data.msg_type === 'tick' && data.tick) {
                        this.liveWsReceiving[data.tick.symbol] = Date.now();
                        this.processTick(data.tick);
                    } else if (data.msg_type === 'balance' && data.balance && this.onBalanceUpdate) {
                        this.onBalanceUpdate(data.balance);
                    } else if (data.msg_type === 'buy' && data.buy && this.onContractPurchased) {
                        this.onContractPurchased(data.buy);
                    }
                } catch (err) {}
            };
            resolve(true);
        });
    }

    switchAccountMode(mode) {
        if (this.accounts.length === 0) return null;
        const target = mode === 'real'
            ? this.accounts.find(a => !a.isVirtual)
            : this.accounts.find(a => a.isVirtual);
        if (target) {
            this.authorize(target.token);
            return target;
        }
        return null;
    }

    authorize(token) {
        if (!token) return;
        this.activeToken = token;
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ authorize: token }));
        }
    }

    buyContract({ symbol, contractType, stake, duration = 5, durationUnit = "t", barrier = null, currency = "USD" }) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.isAuthorized) return false;
        const parameters = {
            amount: Number(stake),
            basis: "stake",
            contract_type: contractType,
            currency: currency,
            duration: Number(duration),
            duration_unit: durationUnit,
            symbol: symbol
        };
        if (barrier !== null && barrier !== undefined && !["DIGITEVEN", "DIGITODD", "CALL", "PUT", "MULTUP"].includes(contractType)) {
            parameters.barrier = String(barrier);
        }
        if (contractType === "ACCU") {
            parameters.growth_rate = Number(barrier) || 0.03;
            delete parameters.barrier;
        }
        this.ws.send(JSON.stringify({ buy: 1, price: Number(stake), parameters: parameters }));
        return true;
    }

    startHybridFallback() {
        if (this.fallbackInterval) return;
        const symbols = [
            '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V',
            'R_10', 'R_25', 'R_50', 'R_75', 'R_100',
            'BOOM500', 'BOOM1000', 'CRASH500', 'CRASH1000',
            'JD10', 'JD25', 'JD50', 'JD75', 'JD100',
            'NVDA', 'TSLA', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'NFLX', 'SPY', 'QQQ',
            'frxEURUSD', 'frxGBPUSD', 'frxUSDJPY', 'frxAUDUSD', 'frxUSDCAD', 'frxNZDUSD', 'frxEURGBP', 'frxUSDCHF', 'frxAUDJPY', 'frxGBPJPY',
            'frxXAUUSD', 'frxXAGUSD', 'frxWTIUSD', 'UK Brent', 'Copper',
            'cryBTCUSD', 'cryETHUSD', 'cryLTCUSD'
        ];
        symbols.forEach(sym => { this.simPrices[sym] = 1000.00; });

        this.fallbackInterval = setInterval(() => {
            const now = Date.now();
            symbols.forEach(sym => {
                if (this.liveWsReceiving[sym] && (now - this.liveWsReceiving[sym] < 3000)) return;
                const step = (Math.random() - 0.48) * 0.35;
                this.simPrices[sym] = Number((this.simPrices[sym] + step).toFixed(2));
                this.processTick({ symbol: sym, quote: this.simPrices[sym], epoch: Math.floor(now / 1000), pip_size: 2 });
            });
        }, 300);
    }

    processTick(tick) {
        if (this.subscribers[tick.symbol]) this.subscribers[tick.symbol](tick);
        if (this.multiSubscribers[tick.symbol]) this.multiSubscribers[tick.symbol](tick);
    }

    subscribeTicks(symbol, cb) {
        this.subscribers[symbol] = cb;
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
        }
    }

    subscribeMultipleTicks(arr, cb) {
        arr.forEach((sym, i) => {
            this.multiSubscribers[sym] = cb;
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                setTimeout(() => { this.ws.send(JSON.stringify({ ticks: sym, subscribe: 1 })); }, i * 30);
            }
        });
    }
}
