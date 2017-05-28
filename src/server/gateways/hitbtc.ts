import Config = require("../config");
import crypto = require('crypto');
import WebSocket = require('uws');
import request = require('request');
import url = require("url");
import querystring = require("querystring");
import NullGateway = require("./nullgw");
import Models = require("../../share/models");
import Utils = require("../utils");
import Interfaces = require("../interfaces");
import io = require("socket.io-client");
import moment = require("moment");
import util = require("util");
const SortedArray = require("collections/sorted-array");

const _lotMultiplier = 100.0;

interface NoncePayload<T> {
    nonce: number;
    payload: T;
}

interface AuthorizedHitBtcMessage<T> {
    apikey : string;
    signature : string;
    message : NoncePayload<T>;
}

interface HitBtcPayload {
}

interface Login extends HitBtcPayload {
}

interface NewOrder extends HitBtcPayload {
    clientOrderId : string;
    symbol : string;
    side : string;
    quantity : number;
    type : string;
    price : number;
    timeInForce : string;
}

interface OrderCancel extends HitBtcPayload {
    clientOrderId : string;
    cancelRequestClientOrderId : string;
    symbol : string;
    side : string;
}

interface HitBtcOrderBook {
    asks : [string, string][];
    bids : [string, string][];
}

interface Update {
    price : number;
    size : number;
    timestamp : number;
}

interface MarketDataSnapshotFullRefresh {
    snapshotSeqNo : number;
    symbol : string;
    exchangeStatus : string;
    ask : Array<Update>;
    bid : Array<Update>
}

interface MarketDataIncrementalRefresh {
    seqNo : number;
    timestamp : number;
    symbol : string;
    exchangeStatus : string;
    ask : Array<Update>;
    bid : Array<Update>
    trade : Array<Update>
}

interface ExecutionReport {
    orderId : string;
    clientOrderId : string;
    execReportType : string;
    orderStatus : string;
    orderRejectReason? : string;
    symbol : string;
    side : string;
    timestamp : number;
    price : number;
    quantity : number;
    type : string;
    timeInForce : string;
    tradeId? : string;
    lastQuantity? : number;
    lastPrice? : number;
    leavesQuantity? : number;
    cumQuantity? : number;
    averagePrice? : number;
}

interface CancelReject {
    clientOrderId : string;
    cancelRequestClientOrderId : string;
    rejectReasonCode : string;
    rejectReasonText : string;
    timestamp : number;
}

interface MarketTrade {
    price : number;
    amount : number;
}

function getJSON<T>(url: string, qs?: any) : Promise<T> {
    return new Promise((resolve, reject) => {
        request({url: url, qs: qs}, (err: Error, resp, body) => {
            if (err) {
                reject(err);
            }
            else {
                try {
                    resolve(JSON.parse(body));
                }
                catch (e) {
                    reject(e);
                }
            }
        });
    });
}

class HitBtcMarketDataGateway implements Interfaces.IMarketDataGateway {
    MarketData = new Utils.Evt<Models.Market>();
    MarketTrade = new Utils.Evt<Models.MarketSide>();
    private readonly _marketDataWs : WebSocket;

    private _hasProcessedSnapshot = false;

    private Eq(a : Models.MarketSide, b : Models.MarketSide) {
        return Math.abs(a.price - b.price) < .1 * this._minTick;
    }

    private AskCmp = (a : Models.MarketSide, b : Models.MarketSide) => {
        if (this.Eq(a, b)) return 0;
        return a.price > b.price ? 1 : -1;
    };

    private BidCmp = (a : Models.MarketSide, b : Models.MarketSide) => {
        if (this.Eq(a, b)) return 0;
        return a.price > b.price ? -1 : 1;
    };

    private readonly _lastBids = new SortedArray([], this.Eq, this.BidCmp);
    private readonly _lastAsks = new SortedArray([], this.Eq, this.AskCmp);
    private onMarketDataIncrementalRefresh = (msg : MarketDataIncrementalRefresh, t : Date) => {
        if (msg.symbol !== this._symbolProvider.symbol || !this._hasProcessedSnapshot) return;
        this.onMarketDataUpdate(msg.bid, msg.ask, t);
    };

    private onMarketDataSnapshotFullRefresh = (msg : MarketDataSnapshotFullRefresh, t : Date) => {
        if (msg.symbol !== this._symbolProvider.symbol) return;
        this._lastAsks.clear();
        this._lastBids.clear();
        this.onMarketDataUpdate(msg.bid, msg.ask, t);
        this._hasProcessedSnapshot = true;
    };

    private onMarketDataUpdate = (bids : Update[], asks : Update[], t : Date) => {
        var ordBids = HitBtcMarketDataGateway.applyIncrementals(bids, this._lastBids);
        var ordAsks = HitBtcMarketDataGateway.applyIncrementals(asks, this._lastAsks);

        this.MarketData.trigger(new Models.Market(ordBids, ordAsks, t));
    };

    private static applyIncrementals(incomingUpdates : Update[], side : any) {
        for (var i = 0; i < incomingUpdates.length; i++) {
            var u : Update = incomingUpdates[i];
            var ms = new Models.MarketSide(parseFloat(<any>u.price), u.size / _lotMultiplier);
            if (u.size == 0) {
                side.delete(ms);
            }
            else {
                var existing = side.get(ms);
                if (existing !== undefined) {
                    existing.size = ms.size;
                }
                else {
                    side.push(ms);
                }
            }
        }

        return side.slice(0, 5);
    }

    private onMessage = (raw : Models.Timestamped<string>) => {
        try {
            var msg = JSON.parse(raw.data);
        }
        catch (e) {
            console.error('hitbtc', e, 'Error parsing msg', raw);
            throw e;
        }

        if (msg.hasOwnProperty("MarketDataIncrementalRefresh")) {
            this.onMarketDataIncrementalRefresh(msg.MarketDataIncrementalRefresh, raw.time);
        }
        else if (msg.hasOwnProperty("MarketDataSnapshotFullRefresh")) {
            this.onMarketDataSnapshotFullRefresh(msg.MarketDataSnapshotFullRefresh, raw.time);
        }
        else {
            console.info('hitbtc', 'unhandled message', msg);
        }
    };

    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();
    private onConnectionStatusChange = () => {
        if (this._marketDataWs.OPEN && this._tradesClient.connected) {
            this.ConnectChanged.trigger(Models.ConnectivityStatus.Connected);
        }
        else {
            this.ConnectChanged.trigger(Models.ConnectivityStatus.Disconnected);
        }
    };

    private onTrade = (t: MarketTrade) => {
        var side : Models.Side = Models.Side.Unknown;
        if (this._lastAsks.any() && this._lastBids.any()) {
            var distance_from_bid = Math.abs(this._lastBids.max() - t.price);
            var distance_from_ask = Math.abs(this._lastAsks.min() - t.price);
            if (distance_from_bid < distance_from_ask) side = Models.Side.Bid;
            if (distance_from_bid > distance_from_ask) side = Models.Side.Ask;
        }

        this.MarketTrade.trigger(new Models.GatewayMarketTrade(t.price, t.amount, new Date(), false, side));
    };

    _tradesClient : SocketIOClient.Socket;

    constructor(config : Config.IConfigProvider, private _symbolProvider: HitBtcSymbolProvider, private _minTick) {
        this._marketDataWs = new WebSocket(config.GetString("HitBtcMarketDataUrl"));
        this._marketDataWs.on('open', this.onConnectionStatusChange);
        this._marketDataWs.on('message', this.onMessage);
        this._marketDataWs.on("close", (code, msg) => {
            this.onConnectionStatusChange();
            console.warn('hitbtc', 'close code=', code, 'msg=', msg);
        });
        this._marketDataWs.on("error", err => {
            this.onConnectionStatusChange();
            console.error('hitbtc', err);
            throw err;
        });

        console.info('hitbtc', 'socket.io', config.GetString("HitBtcSocketIoUrl") + "/trades/" + this._symbolProvider.symbol);
        this._tradesClient = io.connect(config.GetString("HitBtcSocketIoUrl") + "/trades/" + this._symbolProvider.symbol);
        this._tradesClient.on("connect", this.onConnectionStatusChange);
        this._tradesClient.on("trade", this.onTrade);
        this._tradesClient.on("disconnect", this.onConnectionStatusChange);

        request.get(
            {url: url.resolve(config.GetString("HitBtcPullUrl"), "/api/1/public/" + this._symbolProvider.symbol + "/orderbook")},
            (err, body, resp) => {
                this.onMarketDataSnapshotFullRefresh(resp, new Date());
            });

        request.get(
            {url: url.resolve(config.GetString("HitBtcPullUrl"), "/api/1/public/" + this._symbolProvider.symbol + "/trades"),
             qs: {from: 0, by: "trade_id", sort: 'desc', start_index: 0, max_results: 100}},
            (err, body, resp) => {
                JSON.parse((<any>body).body).trades.forEach(t => {
                    var price = parseFloat(t[1]);
                    var size = parseFloat(t[2]);
                    var time = new Date(t[3]);

                    this.MarketTrade.trigger(new Models.GatewayMarketTrade(price, size, time, true, null));
                });
            })
    }
}

class HitBtcOrderEntryGateway implements Interfaces.IOrderEntryGateway {
    OrderUpdate = new Utils.Evt<Models.OrderStatusUpdate>();
    private readonly _orderEntryWs : WebSocket;

    public cancelsByClientOrderId = true;

    supportsCancelAllOpenOrders = () : boolean => { return false; };
    cancelAllOpenOrders = () : Promise<number> => { return Promise.resolve(0); };

    _nonce = 1;

    cancelOrder = (cancel : Models.OrderStatusReport) => {
        this.sendAuth<OrderCancel>("OrderCancel", {clientOrderId: cancel.orderId,
            cancelRequestClientOrderId: cancel.orderId + "C",
            symbol: this._symbolProvider.symbol,
            side: HitBtcOrderEntryGateway.getSide(cancel.side)}, () => {
                this.OrderUpdate.trigger({
                    orderId: cancel.orderId,
                    computationalLatency: new Date().valueOf() - cancel.time.valueOf()
                });
            });
    };

    replaceOrder = (replace : Models.OrderStatusReport) => {
        this.cancelOrder(replace);
        return this.sendOrder(replace);
    };

    sendOrder = (order : Models.OrderStatusReport) => {
        var hitBtcOrder : NewOrder = {
            clientOrderId: order.orderId,
            symbol: this._symbolProvider.symbol,
            side: HitBtcOrderEntryGateway.getSide(order.side),
            quantity: order.quantity * _lotMultiplier,
            type: HitBtcOrderEntryGateway.getType(order.type),
            price: order.price,
            timeInForce: HitBtcOrderEntryGateway.getTif(order.timeInForce)
        };

        this.sendAuth<NewOrder>("NewOrder", hitBtcOrder, () => {
            this.OrderUpdate.trigger({
                orderId: order.orderId,
                computationalLatency: new Date().valueOf() - order.time.valueOf()
            });
        });
    };

    private static getStatus(m : ExecutionReport) : Models.OrderStatus {
        switch (m.execReportType) {
            case "new":
            case "status":
                return Models.OrderStatus.Working;
            case "canceled":
            case "expired":
                return Models.OrderStatus.Cancelled;
            case "rejected":
                return Models.OrderStatus.Rejected;
            case "trade":
                if (m.orderStatus == "filled")
                    return Models.OrderStatus.Complete;
                else
                    return Models.OrderStatus.Working;
            default:
                return Models.OrderStatus.Other;
        }
    }

    private static getTif(tif : Models.TimeInForce) {
        switch (tif) {
            case Models.TimeInForce.FOK:
                return "FOK";
            case Models.TimeInForce.GTC:
                return "GTC";
            case Models.TimeInForce.IOC:
                return "IOC";
        }
    }

    private static getSide(side : Models.Side) {
        switch (side) {
            case Models.Side.Bid:
                return "buy";
            case Models.Side.Ask:
                return "sell";
            default:
                throw new Error("Side " + Models.Side[side] + " not supported in HitBtc");
        }
    }

    private static getType(t : Models.OrderType) {
        switch (t) {
            case Models.OrderType.Limit:
                return "limit";
            case Models.OrderType.Market:
                return "market";
        }
    }

    private onExecutionReport = (tsMsg : Models.Timestamped<ExecutionReport>) => {
        var t = tsMsg.time;
        var msg = tsMsg.data;

        var ordStatus = HitBtcOrderEntryGateway.getStatus(msg);
        var status : Models.OrderStatusUpdate = {
            exchangeId: msg.orderId,
            orderId: msg.clientOrderId,
            orderStatus: ordStatus,
            time: t,
            rejectMessage: msg.orderRejectReason,
            lastQuantity: msg.lastQuantity > 0 ? msg.lastQuantity / _lotMultiplier : undefined,
            lastPrice: msg.lastQuantity > 0 ? msg.lastPrice : undefined,
            leavesQuantity: ordStatus == Models.OrderStatus.Working ? msg.leavesQuantity / _lotMultiplier : undefined,
            cumQuantity: msg.cumQuantity / _lotMultiplier,
            averagePrice: msg.averagePrice
        };

        this.OrderUpdate.trigger(status);
    };

    private onCancelReject = (tsMsg : Models.Timestamped<CancelReject>) => {
        var msg = tsMsg.data;
        var status : Models.OrderStatusUpdate = {
            orderId: msg.clientOrderId,
            rejectMessage: msg.rejectReasonText,
            orderStatus: Models.OrderStatus.Rejected,
            cancelRejected: true,
            time: tsMsg.time
        };
        this.OrderUpdate.trigger(status);
    };

    private authMsg = <T>(payload : T) : AuthorizedHitBtcMessage<T> => {
        var msg = {nonce: this._nonce, payload: payload};
        this._nonce += 1;

        var signMsg = m => {
            return crypto.createHmac('sha512', this._secret)
                .update(JSON.stringify(m))
                .digest('base64');
        };

        return {apikey: this._apiKey, signature: signMsg(msg), message: msg};
    };

    private sendAuth = <T extends HitBtcPayload>(msgType : string, msg : T, cb?: () => void) => {
        var v = {};
        v[msgType] = msg;
        var readyMsg = this.authMsg(v);
        this._orderEntryWs.send(JSON.stringify(readyMsg), cb);
    };

    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();
    private onConnectionStatusChange = () => {
        if (this._orderEntryWs.OPEN) {
            this.ConnectChanged.trigger(Models.ConnectivityStatus.Connected);
        }
        else {
            this.ConnectChanged.trigger(Models.ConnectivityStatus.Disconnected);
        }
    };

    private onOpen = () => {
        this.sendAuth("Login", {});
        this.onConnectionStatusChange();
    };

    private onClosed = (code, msg) => {
        this.onConnectionStatusChange();
        console.warn('hitbtc', 'close code=', code, 'msg=', msg);
    };

    private onError = (err : Error) => {
        this.onConnectionStatusChange();
        console.error('hitbtc', err);
        throw err;
    };

    private onMessage = (raw : Models.Timestamped<string>) => {
        try {
            var t = new Date();
            var msg = JSON.parse(raw.data);
            if (msg.hasOwnProperty("ExecutionReport")) {
                this.onExecutionReport(new Models.Timestamped(msg.ExecutionReport, raw.time));
            }
            else if (msg.hasOwnProperty("CancelReject")) {
                this.onCancelReject(new Models.Timestamped(msg.CancelReject, raw.time));
            }
            else {
                console.info('hitbtc', 'unhandled message', msg);
            }
        }
        catch (e) {
            console.error('hitbtc', e, 'exception while processing message', raw);
            throw e;
        }
    };

    generateClientOrderId = (): string => new Date().valueOf().toString().substr(-9);

    private _apiKey : string;
    private _secret : string;
    constructor(config : Config.IConfigProvider, private _symbolProvider: HitBtcSymbolProvider, private _details: HitBtcBaseGateway) {
        this._apiKey = config.GetString("HitBtcApiKey");
        this._secret = config.GetString("HitBtcSecret");
        this._orderEntryWs = new WebSocket(config.GetString("HitBtcOrderEntryUrl"));
        this._orderEntryWs.on('open', this.onOpen);
        this._orderEntryWs.on('message', this.onMessage);
        this._orderEntryWs.on('close', this.onConnectionStatusChange);
    }
}

interface HitBtcPositionReport {
    currency_code : string;
    cash : number;
    reserved : number;
}

class HitBtcPositionGateway implements Interfaces.IPositionGateway {
    PositionUpdate = new Utils.Evt<Models.CurrencyPosition>();

    private getAuth = (uri : string) : any => {
        var nonce : number = new Date().getTime() * 1000; // get rid of *1000 after getting new keys
        var comb = uri + "?" + querystring.stringify({nonce: nonce, apikey: this._apiKey});

        var signature = crypto.createHmac('sha512', this._secret)
                              .update(comb)
                              .digest('hex')
                              .toString()
                              .toLowerCase();

        return {url: url.resolve(this._pullUrl, uri),
                method: "GET",
                headers: {"X-Signature": signature},
                qs: {nonce: nonce.toString(), apikey: this._apiKey}};
    };

    private onTick = () => {
        request.get(
            this.getAuth("/api/1/trading/balance"),
            (err, body, resp) => {
                try {
                    var rpts: Array<HitBtcPositionReport> = JSON.parse(resp).balance;
                    if (typeof rpts === 'undefined' || err) {
                        console.warn('hitbtc', err, 'Error getting positions', body.body);
                        return;
                    }

                    rpts.forEach(r => {
                        try {
                            var currency = Models.toCurrency(r.currency_code);
                        }
                        catch (e) {
                            return;
                        }
                        if (currency == null) return;
                        var position = new Models.CurrencyPosition(r.cash, r.reserved, currency);
                        this.PositionUpdate.trigger(position);
                    });
                }
                catch (e) {
                    console.error('hitbtc', e, 'Error processing JSON response ', resp);
                }
            });
    };

    private readonly _apiKey : string;
    private readonly _secret : string;
    private readonly _pullUrl : string;
    constructor(config : Config.IConfigProvider) {
        this._apiKey = config.GetString("HitBtcApiKey");
        this._secret = config.GetString("HitBtcSecret");
        this._pullUrl = config.GetString("HitBtcPullUrl");
        this.onTick();
        setInterval(this.onTick, 15000);
    }
}

class HitBtcBaseGateway implements Interfaces.IExchangeDetailsGateway {
    public get hasSelfTradePrevention() {
        return false;
    }

    exchange() : Models.Exchange {
        return Models.Exchange.HitBtc;
    }

    makeFee() : number {
        return -0.0001;
    }

    takeFee() : number {
        return 0.001;
    }

    name() : string {
        return "HitBtc";
    }

    constructor(public minTickIncrement: number, public minSize: number) {}
}

class HitBtcSymbolProvider {
    public symbol : string;

    constructor(pair: Models.CurrencyPair) {
        this.symbol = Models.fromCurrency(pair.base) + Models.fromCurrency(pair.quote);
    }
}

class HitBtc extends Interfaces.CombinedGateway {
    constructor(config : Config.IConfigProvider, symbolProvider: HitBtcSymbolProvider, step: number, minSize: number, pair: Models.CurrencyPair) {
        const details = new HitBtcBaseGateway(step, minSize);
        const orderGateway = config.GetString("HitBtcOrderDestination") == "HitBtc" ?
            <Interfaces.IOrderEntryGateway>new HitBtcOrderEntryGateway(config, symbolProvider, details)
            : new NullGateway.NullOrderGateway();

        // Payment actions are not permitted in demo mode -- helpful.
        let positionGateway : Interfaces.IPositionGateway = new HitBtcPositionGateway(config);
        if (config.GetString("HitBtcPullUrl").indexOf("demo") > -1) {
            positionGateway = new NullGateway.NullPositionGateway(pair);
        }

        super(
            new HitBtcMarketDataGateway(config, symbolProvider, step),
            orderGateway,
            positionGateway,
            details);
    }
}

interface HitBtcSymbol {
    symbol: string,
    step: string,
    lot: string,
    currency: string,
    commodity: string,
    takeLiquidityRate: string,
    provideLiquidityRate: string
}

export async function createHitBtc(config : Config.IConfigProvider, pair: Models.CurrencyPair) : Promise<Interfaces.CombinedGateway> {
    const symbolsUrl = config.GetString("HitBtcPullUrl") + "/api/1/public/symbols";
    const symbols = await getJSON<{symbols: HitBtcSymbol[]}>(symbolsUrl);
    const symbolProvider = new HitBtcSymbolProvider(pair);

    for (let s of symbols.symbols) {
        if (s.symbol === symbolProvider.symbol)
            return new HitBtc(config, symbolProvider, parseFloat(s.step), 0.01, pair);
    }

    throw new Error("unable to match pair to a hitbtc symbol " + pair.toString());
}