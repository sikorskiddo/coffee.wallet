'use strict'

var bitcoin = require('bitcoinjs-lib');
var bip39 = require('bip39');
var createHmac = require('create-hmac');
var base58 = require('bs58');

var networks = {
	ltc: {
		webapi: 'https://api.blockcypher.com/v1/ltc/main',
		defaultFee: 10000,
		network: bitcoin.networks.litecoin
	},
	btc: {
		webapi: 'https://api.blockcypher.com/v1/btc/main',
		defaultFee: 10000,
		network: bitcoin.networks.bitcoin
	},
	test: {
		webapi: 'https://api.blockcypher.com/v1/btc/test3',
		defaultFee: 10000,
		network: bitcoin.networks.testnet
	},
	doge: {
		webapi: 'https://api.blockcypher.com/v1/doge/main',
		defaultFee: 100000000,
		network: {
			messagePrefix: '\x19Dogecoin Signed Message:\n',
			bip32: {
				public: 0x02facafd,
				private: 0x02fac398
			},
			pubKeyHash: 0x1e,
			scriptHash: 0x16,
			wif: 0x9e
		}
	},
	eth: {
		network: {
			messagePrefix: '\x19Ethereum Signed Message:\n',
	  	bip32: {
	    	public: 0xffffffff,
	    	private: 0xffffffff
	  	},
	  	pubKeyHash: 0xff,
			scriptHash: 0xff,
	  	wif: 0xff
		}
	},
	decred: {
	  network: {
		 messagePrefix: '\x19Decred Signed Message:\n',
		 bip32: {
			 public: 0x02fda926,
			 private: 0x02fda4e8
		 },
		 pubKeyHash: 0x73f,
		 scriptHash: 0x71a,
		 wif: 0x22de
	 }
 }
}

var _webRequestQueue = new Array();
function _webRequestProcessor () {
	var request = _webRequestQueue.pop();
	var xhr = new XMLHttpRequest();
	xhr.open('GET', request.url, true);
	xhr.responseType = 'json';
	xhr.onreadystatechange = function () {
	    if (xhr.readyState === 4) {
				console.log(request.url);
				request.callback(xhr);
	    }
	};
	xhr.send();
	if (_webRequestQueue.length > 0) setTimeout(_webRequestProcessor, 400);
}

function sendWebRequestGetQueued (url, callback) {
	_webRequestQueue.push({'url': url, 'callback': callback});
	if (_webRequestQueue.length == 1) setTimeout(_webRequestProcessor, 400);
}

function newPrivKey (network) {
	return bitcoin.ECPair.makeRandom({network:network.network}).toWIF();
}

function addrFromPriv (network, pk) {
	return bitcoin.ECPair.fromWIF(pk, network.network).getAddress();
}

function getBalance (network, addr, callback, error) {
	sendWebRequestGetQueued(network.webapi + '/addrs/' + addr + '/balance', function(xhr) {
		if (xhr.status === 200) {
			callback(xhr.response.balance, xhr.response.unconfirmed_balance);
		} else {
			error('network error ' + xhr.status);
		}
	});
}

/*function smartRound(f) {
  return parseFloat(f.toExponential(Math.max(4, 4 + Math.log10(Math.abs(f)))));
}*/

function generateFeesFromAvg(avgFee) {
	var t = 10; //TODO avarage block time
	var factors = [0.2, 0.4, 0.6, 0.8, 1, 1.3, 1.7, 2.3, 3];
	var newFees = [];
	for (var i=0; i<factors.length; i++) {
		//fee: [satoshiPerByte, timeEst]
		newFees.push([Math.round(avgFee * factors[i]), (t / factors[i]).toFixed(2)]);
	}
	return newFees;
}

function getFees (network, callback, error) {
	//TODO. use dedicated API
	var xhr = new XMLHttpRequest();
	xhr.open('GET', network.webapi, true);
	xhr.responseType = 'json';
	xhr.onload = function() {
		if (xhr.status === 200) {
			var xhr2 = new XMLHttpRequest();
			xhr2.open('GET', xhr.response.latest_url, true);
			xhr2.responseType = 'json';
			xhr2.onload = function() {
				if (xhr2.status === 200) {
					if (('fees' in xhr2.response) && (xhr2.response.fees > 0) && ('size' in xhr2.response) && (xhr2.response.size > 0)) {
						callback(generateFeesFromAvg((xhr2.response.fees / xhr2.response.size) * 256));
					} else {
						callback(generateFeesFromAvg(network.defaultFee));
					}
				} else {
					callback(generateFeesFromAvg(network.defaultFee));
				}
			}
			xhr2.send();
		} else {
			callback(generateFeesFromAvg(network.defaultFee));
		}
	};
	xhr.send();
}

function sendPayment (network, pk, receiver, amount, fee, success, error) {
	if ((!Number.isInteger(amount)) || (!Number.isInteger(fee))) {
		error('amounts needs to be integers');
		return;
	}

	var key = bitcoin.ECPair.fromWIF(pk, network.network);
	var xhr = new XMLHttpRequest();
	xhr.open('GET', network.webapi + '/addrs/' + key.getAddress() + '?unspentOnly=true', true);
	xhr.responseType = 'json';
	xhr.onload = function() {
		if (xhr.status === 200) {
			//
			var txb = new bitcoin.TransactionBuilder(network.network);
			var totalIn = 0;
			var vins = [];

			if ('txrefs' in xhr.response) {
				for (var i = xhr.response.txrefs.length - 1; i >= 0; i --) {
					totalIn += xhr.response.txrefs[i].value;
					vins.push(txb.addInput(xhr.response.txrefs[i].tx_hash, parseInt(xhr.response.txrefs[i].tx_output_n)));
					//console.log(txb.inputs);
					if (totalIn >= amount + fee) break; //we have enough fees
				}
			}
			if ('unconfirmed_txrefs' in xhr.response) {
				if (xhr.response.unconfirmed_txrefs.length > 0) {
					app.alertInfo('warning: sending using unconfirmed inputs!');
				}
				for (var i = xhr.response.unconfirmed_txrefs.length - 1; i >= 0; i --) {
					totalIn += xhr.response.unconfirmed_txrefs[i].value;
					vins.push(txb.addInput(xhr.response.unconfirmed_txrefs[i].tx_hash, parseInt(xhr.response.unconfirmed_txrefs[i].tx_output_n)));
					//console.log(txb.inputs);
					if (totalIn >= amount + fee) break; //we have enough fees
				}
			}

			if (totalIn < amount + fee) {
				error('No sufficient funds on source wallet. Total confirmed and unconfirmed balance is ' + (totalIn* 0.00000001) + '', xhr.response);
				return;
			}
			//console.log(totalIn, amount, totalIn - amount - fee);

			txb.addOutput(receiver, amount);
			//calculating change
			var change = totalIn - amount - fee;

			if (change > 0) {
				if (change < fee) {
					app.alertInfo('warning. dust leftover detected. transaction might fail. consider using "send all" feature next time.');
				}
				//TODO new address:
				txb.addOutput(key.getAddress(), change);
			}

			for (var i=0; i<vins.length; i++){
				//sign all inputs
				txb.sign(vins[i], key);
			}

			//console.log(txb.build().virtualSize());

			//console.log(txb.build().toHex());
			var pushXhr = new XMLHttpRequest();
			pushXhr.open('POST', network.webapi + '/txs/push', true);
			pushXhr.setRequestHeader("Content-Type", "application/json");
			pushXhr.responseType = 'json';
			pushXhr.onload = function() {
				if (pushXhr.status === 201) {
					success(pushXhr.response.tx.hash);
				} else {
					error('error' in pushXhr.response ? pushXhr.response.error : 'unknown error', pushXhr.response);
				}
			};
			//console.log(txb.inputs);
			pushXhr.send(JSON.stringify({tx:txb.build().toHex()}));

		} else {
			error && error(xhr.statusText, xhr);
		}
	};
	xhr.send();
}

function validateAddress (network, addr) {
	try{
		bitcoin.address.toOutputScript(addr, network.network);
		return true;
	} catch (e) {
		return false;
	}
}

function derivePathFromSeedHash(network, sh, path) {
	return bitcoin.HDNode.fromSeedHex(sh, network.network).derivePath(path).keyPair;
}
function hmacSha512Sign(data, secret) {
	return createHmac('sha512', secret).update(data).digest('hex');
}

module.exports = {
	_webRequestProcessor: _webRequestProcessor,
	networks: networks,
	newPrivKey: newPrivKey,
	addrFromPriv: addrFromPriv,
	getBalance: getBalance,
	getFees: getFees,
	validateAddress: validateAddress,
	sendPayment: sendPayment,

	generateNewMnemonic: bip39.generateMnemonic,
	mnemonicToSeedHex: bip39.mnemonicToSeedHex,
	validateMnemonic: bip39.validateMnemonic,

	derivePathFromSeedHash: derivePathFromSeedHash,
	hmacSha512Sign: hmacSha512Sign,
	base58: base58
}
