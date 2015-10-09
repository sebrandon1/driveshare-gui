/* global $ */
/* global w2ui */
/* global w2popup */

'use strict';

var os = require('os');
var fs = require('fs');
var remote = require('remote');
var request = require('request');
var app = remote.require('app');
var ipc = require("electron-safe-ipc/guest");
var pjson = require('./package.json');

exports.currentSJXC;
exports.dataservClient = '';
exports.payoutAddress = '';
exports.dataservDirectory = '';
exports.dataservSize = '';

exports.init = function() {

	// load data from config file
	 try {
		exports.readUserData();
	} catch (error) {
		console.log(error.toString());
	}

	// HAX = temporary workaroud while automatic setup isn't working on OSX
	if(os.platform() !== 'win32') {
		exports.dataservClient = 'dataserv-client';
	}
};

exports.readUserData = function() {
	// load data from config file
	 try {
		//test to see if settings exist
		var path = app.getPath('userData') + '/' + window.env.configFileName;
		console.log('Reading settings from \'' + path + '\'');
		fs.openSync(path, 'r+'); //throws error if file doesn't exist
		var data = fs.readFileSync(path); //file exists, get the contents
		var userData = JSON.parse(data); //turn to js object
		for(var s in userData) {
			exports[s] = userData[s];
		}
	} catch (error) {
		console.log(error.toString());
	}
};

exports.saveUserData = function() {
	try {
		var path = app.getPath('userData') + '/' + window.env.configFileName;
		fs.writeFileSync(path, JSON.stringify({
			dataservClient: exports.dataservClient,
			payoutAddress: exports.payoutAddress,
			dataservDirectory: exports.dataservDirectory,
			dataservSize: exports.dataservSize
		}) , 'utf-8');
		console.log('Saved settings to \'' + path + '\'');
		requirejs('./modules/process').saveConfig();
		exports.querySJCX();
	} catch (error) {
		console.log(error.toString());
	}
};

exports.hasValidDataservClient = function() {
	return exports.dataservClient !== undefined && exports.dataservClient !== '';
};

exports.hasValidPayoutAddress = function() {
	return exports.payoutAddress !== undefined && exports.payoutAddress !== '';
};

exports.hasValidDataservDirectory = function() {
	return exports.dataservDirectory !== undefined && exports.dataservDirectory !== '';
};

exports.hasValidDataservSize = function() {
	return exports.dataservSize !== undefined && exports.dataservSize !== '';
};

exports.hasValidSettings = function() {
	return (exports.hasValidDataservClient() &&
			exports.hasValidPayoutAddress());
};

exports.querySJCX = function(onComplete) {
	if(exports.hasValidPayoutAddress()) {
		request("http =//xcp.blockscan.com/api2?module=address&action=balance&btc_address=" + exports.payoutAddress + "&asset=SJCX",
		function (error, response, body) {
			if (!error && response.statusCode == 200) {
				var json = JSON.parse(body);
				if(json.status !== "error") {
					exports.currentSJXC = json.data[0].balance;
				}
			}
			if(w2ui['layout']) {
				requirejs('./modules/layout').refreshContent();
			}
		});
	}
}