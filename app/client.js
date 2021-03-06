/**
 * @module storjshare-gui/client
 */

'use strict';

var $ = window.jQuery = require('jquery');
var Vue = require('vue');

require('bootstrap'); // init bootstrap js

var pkginfo = require('./package');
var utils = require('./lib/utils');
var helpers = require('./lib/helpers');
var electron = require('electron');
var remote = electron.remote;
var app = remote.app;
var ipc = electron.ipcRenderer;
var shell = electron.shell;
var about = require('./package');
var Updater = require('./lib/updater');
var UserData = require('./lib/userdata');
var Tab = require('./lib/tab');
var storj = require('storj-lib');
var Monitor = storj.Monitor;
var SpeedTest = require('myspeed').Client;
var userdata = new UserData(app.getPath('userData'));
var Logger = require('kad-logger-json');
var FsLogger = require('./lib/fslogger');
var TelemetryReporter = require('storj-telemetry-reporter');
var shuffle = require('knuth-shuffle').knuthShuffle;

// bootstrap helpers
helpers.ExternalLinkListener().bind(document);

/**
 * About View
 */
var about = new Vue({
  el: '#about',
  data: {
    version: about.version,
    core: storj.version.software,
    protocol: storj.version.protocol
  },
  methods: {
    show: function(event) {
      if (event) {
        event.preventDefault();
      }

      $('#about').modal('show');
    }
  },
  created: function() {
    var view = this;

    ipc.on('showAboutDialog', function() {
      view.show();
    });
  }
});

/**
 * Updater View
 */
var updater = new Vue({
  el: '#updater',
  data: {
    update: false,
    releaseURL: '',
    releaseTag: ''
  },
  methods: {
    download: function(event) {
      if (event) {
        event.preventDefault();
      }

      if (window.confirm('You must quit Storj Share to upgrade. Continue?')) {
        shell.openExternal(this.releaseURL);
        app.quit();
      }

    }
  },
  created: function() {
    var view = this;
    var updater = new Updater();

    ipc.on('checkForUpdates', function() {
      updater.check();
      $('#updater').modal('show');
    });

    updater.check();

    updater.on('update_available', function(meta) {
      view.update = true;
      view.releaseTag = meta.releaseTag;
      view.releaseURL = meta.releaseURL;

      $('#updater').modal('show');
    });

    updater.on('error', function(err) {
      console.log(err);
    });
  }
});

/**
 * Main View
 */
var main = new Vue({
  el: '#main',
  data: {
    userdata: userdata._parsed,
    current: 0,
    freespace: {size: 0, unit: 'B'},
    balance: {
      sjcx: 0,
      sjct: 0,
      qualified: false
    },
    error: {drive: '', message: ''},
    telemetry: {},
    telemetryWarningDismissed: localStorage.getItem('telemetryWarningDismissed')
  },
  methods: {
    dismissTelemetryWarning: function() {
      this.telemetryWarningDismissed = true;
      localStorage.setItem('telemetryWarningDismissed', true);
    },
    addTab: function(event) {
      if (event) {
        event.preventDefault();
      }
      this.showTab(this.userdata.tabs.push(new Tab()) - 1);
      ipc.send('appSettingsChanged', JSON.stringify(userdata.toObject()));
    },
    showTab: function(index) {
      var self = this;

      // create Tab If None Found
      if (!self.userdata.tabs[index]) {
        return self.addTab();
      }

      // set Previous Tab To Inactive
      if (self.userdata.tabs[self.current]) {
        self.userdata.tabs[self.current].active = false;
      }

      if (index === -1) {
        this.current = 0;

        if (!this.userdata.tabs[this.current]) {
          this.addTab();
        }
      } else {
        this.current = index;
        this.userdata.tabs[this.current].active = true;
      }

      this.getBalance(this.userdata.tabs[this.current]);
      this.getFreeSpace(this.userdata.tabs[this.current]);
    },
    removeTab: function(event) {
      if (event) {
        event.stopPropagation();
      }

      if (!window.confirm('Are you sure you want to remove this drive?')) {
        return;
      }

      this.stopFarming();
      this.userdata.tabs.splice(this.current, 1);
      this.showTab((this.current - 1) === -1 ? 0 : this.current - 1);

      ipc.send('appSettingsChanged', JSON.stringify(userdata.toObject()));
      userdata.saveConfig(function(err) {
        if (err) {
          return window.alert(err.message);
        }
      });
    },
    selectStorageDirectory: function() {
      ipc.send('selectStorageDirectory');
    },
    startFarming: function(event, index) {
      var self = this;
      var current = (index) ? index : this.current;
      var tab = this.userdata.tabs[current];
      var appSettings = this.userdata.appSettings;
      var fslogger;

      try {
        fslogger = new FsLogger(
          appSettings.logFolder, 'StorjDrive-' + tab.shortId
        );
      } catch (err) {
        tab.wasRunning = false;
        return window.alert(err.message);
      }

      fslogger.setLogLevel(Number(appSettings.logLevel));

      fslogger.on('error', function(err) {
        console.log(err.message);
      });

      if (event) {
        event.preventDefault();
      }

      try {
        userdata.validate(current);
      } catch(err) {
        return window.alert(err.message);
      }

      userdata.validateAllocation(tab, function(err) {
        if (err) {
          return window.alert(err.message);
        }

        tab.transitioning = true;
        tab.telemetry = { enabled: appSettings.reportTelemetry };

        var seedlist = tab.network.seed ? [tab.network.seed] : [];

        if (tab.restartingFarmer === true) {
          seedlist = shuffle(seedlist);
        }

        var storageAdapter = storj.EmbeddedStorageAdapter(tab.storage.dataDir);
        var logger = new Logger(Number(appSettings.logLevel));
        var reporter = new TelemetryReporter(
          'https://status.storj.io',
          storj.KeyPair(tab.key)
        );
        var farmerconf = {
          keyPair: storj.KeyPair(tab.key),
          paymentAddress: tab.getAddress(),
          storageManager: storj.StorageManager(storageAdapter, {
            maxCapacity: storj.utils.toNumberBytes(
              tab.storage.size,
              tab.storage.unit
            )
            }),
          rpcAddress: tab.network.hostname,
          rpcPort: Number(tab.network.port),
          doNotTraverseNat: tab.network.nat === 'false',
          logger: logger,
          tunnelServerPort: Number(tab.tunnels.tcpPort),
          maxTunnels: Number(tab.tunnels.numConnections),
          tunnelGatewayRange: {
            min: Number(tab.tunnels.startPort),
            max: Number(tab.tunnels.endPort)
          },
          seedList: seedlist
        };
        var farmer = new storj.FarmerInterface(farmerconf);

        self.contractCounter(tab, farmer, function(err) {

          if (err) {
            logger.error(err.message);
            tab.transitioning = false;
            return window.alert(err.message);
          }

          // Update by drive
          var contractCountKey = 'contractCount_' + tab.id;
          farmer.storageManager._storage.on('add',function(item){
            tab.lastChange = new Date();
            var contracts = Number(localStorage.getItem(contractCountKey));
            contracts += Object.keys(item.contracts).length;
            localStorage.setItem(contractCountKey, contracts.toString());
            tab.contracts.total = contracts;
          });

          farmer.storageManager._storage.on('update',function(previous, next){
            tab.lastChange = new Date();
            var contracts = Number(localStorage.getItem(contractCountKey));
            previous = Object.keys(previous.contracts).length;
            next = Object.keys(next.contracts).length;
            contracts += next - previous;
            localStorage.setItem(contractCountKey, contracts.toString());
            tab.contracts.total = contracts;
          });

          farmer.storageManager._storage.on('delete',function(item){
            tab.lastChange = new Date();
            var contracts = Number(localStorage.getItem(contractCountKey));
            contracts -= Object.keys(item.contracts).length;
            localStorage.setItem(contractCountKey, contracts.toString());
            tab.contracts.total = contracts;
          });

          tab.reporter = function() {
            return reporter;
          };

          tab.farmer = function() {
            return farmer;
          };

          logger.on('log', function(data) {
            fslogger.log(data.level, data.timestamp, data.message);
          });

          tab.wasRunning = true;
          ipc.send('appSettingsChanged', JSON.stringify(userdata.toObject()));

          userdata.saveConfig(function(err) {
            if (err) {
              tab.transitioning = false;
              return window.alert(err.message);
            }

            farmer.join(function(err) {

              // Farmer has been started/restarted
              tab.restartingFarmer = false;
              tab.transitioning = false;

              if (appSettings.reportTelemetry) {
                self.startReportingTelemetry(tab);
              }

              if (err) {
                logger.error(err.message);

                if (appSettings.retryOnError === true) {
                  logger.warn(
                    'An error occurred. Restarting farmer [%s]...',
                    tab.shortId
                  );
                  self.restartFarmer(event, tab);
                } else {
                  self.stopFarming(event, tab);
                  self.error.message = err;
                  self.error.drive = tab.shortId;
                  $('#error').modal({
                    backdrop: 'static',
                    keyboard: false,
                    show: true}
                  );
                }
              }
            });
          });
        });
      });
    },
    contractCounter: function(tab, farmer, callback) {
      var contractCountKey = 'contractCount_' + tab.id;
      var contracts = localStorage.getItem(contractCountKey);
      if (contracts === null || Number(contracts) === 0 ) {
        try {
          $('#loading').modal({
            backdrop: 'static',
            keyboard: false,
            show: true}
          );

          Monitor.getContractsDetails(farmer, function(err, stats) {
            localStorage.setItem(
              contractCountKey,
              (stats.contracts.total).toString()
            );
            tab.contracts.total = stats.contracts.total;
            $('#loading').modal('hide');
            return callback();
          });
        } catch (err) {
          return callback(err);
        }
      } else {
        tab.contracts.total = Number(contracts);
        return callback();
      }
    },
    stopFarming: function(event, tab) {
      var self = this;

      if (event) {
        event.preventDefault();
      }

      tab = (!tab) ? this.userdata.tabs[this.current]: tab;

      if (tab.farmer) {
        if (self.userdata.appSettings.reportTelemetry) {
          self.stopReportingTelemetry(tab);
        }

        tab.wasRunning = false;
        tab.transitioning = true;

        tab.farmer().leave(function() {
          tab.transitioning = false;
          tab.farmer = null;
        });
      }

      ipc.send('appSettingsChanged', JSON.stringify(userdata.toObject()));

      userdata.saveConfig(function(err) {
        if (err) {
          return window.alert(err.message);
        }
      });
    },
    restartFarmer: function(event, tab) {
      var self = this;
      console.log('{info} Restarting farmer [' + tab.shortId +'] ...');

      tab.restartingFarmer = true;

      if (event) {
        event.preventDefault();
      }

      tab = (!tab) ? this.userdata.tabs[this.current]: tab;

      if (tab.farmer) {
        if (self.userdata.appSettings.reportTelemetry) {
          self.stopReportingTelemetry(tab);
        }

        tab.wasRunning = false;
        tab.transitioning = true;

        tab.farmer().leave(function() {
          tab.farmer = null;
          self.startFarming(event, self.current);
        });
      }
    },
    startReportingTelemetry: function(tab) {
      var farmer = tab.farmer();
      var id = farmer.contact.nodeID;
      var reporter = tab.reporter();

      if (this.telemetry[id]) {
        clearInterval(this.telemetry[id]);
      }

      function report() {
        var bandwidth = localStorage.getItem('telemetry_speedtest');
        var needstest = false;
        var hours25 = 60 * 60 * 25 * 1000;

        function send() {
          utils.getDirectorySize(tab.storage.dataDir, function(err, size) {
            if (err) {
              return console.error('Failed to collect telemetry data');
            }

            var allocatedSpace = utils.manualConvert(
              { size: tab.storage.size, unit: tab.storage.unit },
              'B',
              16
            );

            var report = {
              storage: {
                free: Number((allocatedSpace.size - size).toFixed()),
                used: Number(size.toFixed())
              },
              bandwidth: {
                upload: Number(bandwidth.upload),
                download: Number(bandwidth.download)
              },
              contact: farmer.contact,
              payment: tab.getAddress()
            };

            console.log('[telemetry] sending report', report);
            reporter.send(report, function(err, result) {
              console.log('[telemetry]', err, result);
            });
          });
        }

        if (!bandwidth) {
          needstest = true;
        } else {
          bandwidth = JSON.parse(bandwidth);

          if ((new Date() - new Date(bandwidth.timestamp)) > hours25) {
            needstest = true;
          }
        }

        if (needstest && pkginfo.config.speedTestURL) {
          SpeedTest({
            url: pkginfo.config.speedTestURL
          }).test(function(err, result) {
            if (err) {
              return console.error('[telemetry]', err);
            }

            bandwidth = {
              upload: result.upload,
              download: result.download,
              timestamp: Date.now()
            };

            localStorage.setItem(
              'telemetry_speedtest',
              JSON.stringify(bandwidth)
            );

            send();
          });
        } else {
          send();
        }
      }

      this.telemetry[id] = setInterval(report, 5 * (60 * 1000));

      report();
    },
    stopReportingTelemetry: function(tab) {
      var farmer = tab.farmer();
      var id = farmer.contact.nodeID;

      if (this.telemetry[id]) {
        clearInterval(this.telemetry[id]);
        this.telemetry[id] = null;
      }
    },
    updateTabStats: function(tab, farmer) {

      if (!farmer) {
        return;
      }

      Monitor.getConnectedPeers(farmer, function(err, stats) {
        tab.connectedPeers = stats.peers.connected;
      });

      var used = utils.manualConvert(
        {size: tab.usedspace.size, unit: tab.usedspace.unit},
          'B'
        ).size;

      var allocated = utils.manualConvert(
        {size: tab.storage.size, unit: tab.storage.unit},
          'B'
        ).size;

      var spaceUsedPerc = used / allocated;
      spaceUsedPerc = (spaceUsedPerc > 1) ? 1 : spaceUsedPerc;

      tab.spaceUsedPercent = Number.isNaN(spaceUsedPerc) ?
                             '0' :
                             Math.round(spaceUsedPerc * 100);
    },
    getBalance: function(tab) {
      var self = this;

      if (!tab.address) {
        this.balance.qualified = false;
        return;
      }

      Monitor.getPaymentAddressBalances({
       keyPair: storj.KeyPair(tab.key),
       _options: { paymentAddress: tab.getAddress() }
      }, function(err, stats) {
       self.balance.sjcx = stats.payments.balances.sjcx || 0;
       self.balance.sjct = stats.payments.balances.sjct || 0;
       self.balance.qualified = true;
      });

    },
    getFreeSpace: function(tab) {
      var self = this;

      if (typeof tab.storage.path === undefined) {
        self.freespace = 0;
        return;
      }

      utils.getFreeSpace(tab.storage.path, function(err, free) {
        var freespace = utils.autoConvert({size: free, unit: 'B'});
        self.freespace = freespace;
      });
    }
  },
  created: function() {
    var self = this;
    $('.container').addClass('visible');

    //If terms not acceped before
    var terms = JSON.parse(localStorage.getItem('terms'));
    if (terms === null || terms.accepted !== true ) {
      $('#terms').modal({backdrop: 'static', keyboard: false, show: true});
    }

    if (!this.userdata.tabs.length) {
      this.addTab();
    } else {
      handleRunDrivesOnBoot(this.userdata.appSettings.runDrivesOnBoot);
    }

    function handleRunDrivesOnBoot(isEnabled){
      //iterate over drives and run or iterate over and remove flags
      self.userdata.tabs.forEach(function(tab, index) {
        var contractCountKey = 'contractCount_' + tab.id;
        var contracts = localStorage.getItem(contractCountKey);

        if (tab.wasRunning && isEnabled) {

          if (contracts === null || Number(contracts) === 0 ) {
            tab.wasRunning = false;
          } else {
            self.startFarming(null, index);
          }

        } else if(tab.wasRunning && !isEnabled){
          tab.wasRunning = false;
        }
      });

      userdata.saveConfig(function(err) {
        if (err) {
          return window.alert(err.message);
        }
      });
    }

    this.showTab(this.current);

    // Delete old logs
    setInterval(function() {
      if (self.userdata.appSettings.deleteOldLogs === true) {
        FsLogger.prototype._deleteOldFiles(self.userdata.appSettings.logFolder,
        function(err) {
          if (err) {
            return window.alert(err.message);
          }
        });
      }

      var tab = self.userdata.tabs[self.current];
      self.getBalance(tab);
    }, 7200000);

    // check if active farmer
    setInterval(function() {
      var tab = self.userdata.tabs[self.current];
      var farmer = typeof tab.farmer === 'function' ? tab.farmer() : null;
      var lastChange = tab.lastChange;
      var now = new Date();
      if (
        farmer &&
        lastChange &&
        ((now.getTime() - lastChange.getTime()) > 1800000)
      ) {
        self.restartFarmer(null, tab);
      }
    }, 900000);

    // Update Space stats
    setInterval(function() {
      var tab = self.userdata.tabs[self.current];
      self.getFreeSpace(tab);
      var farmer = typeof tab.farmer === 'function' ? tab.farmer() : null;
      if (farmer) {
        utils.getDirectorySize(tab.storage.dataDir,
            function(err, usedspacebytes) {
            if (usedspacebytes) {
              var usedspace = utils.autoConvert(
                { size: usedspacebytes, unit: 'B' }, 0
              );

              tab.usedspace = usedspace;
            }
          }
        );
        self.updateTabStats(tab, farmer);
      }
    }, 3000);

    ipc.on('selectDriveFromSysTray', function(ev, tabIndex){
      self.showTab(tabIndex);
    });

    ipc.on('storageDirectorySelected', function(ev, path) {
      self.userdata.tabs[self.current].updateStoragePath(path[0]);
      self.getFreeSpace(self.userdata.tabs[self.current]);
      ipc.send('appSettingsChanged', JSON.stringify(userdata.toObject()));
    });

    ipc.on('toggleFarmer', function() {
      var isRunning = !!self.userdata.tabs[self.current].farmer;

      if (isRunning) {
        self.stopFarming();
      } else {
        self.startFarming();
      }
    });
  }
});

/**
 * App Settings View
 */
var appSettings = new Vue({
  el:'#settings',
  data: {
    userdata: userdata._parsed,
    current: main.current
  },
  methods: {
    validatePort: function(port) {
      port = Number(port);
      var min = 1000;
      var max = 65535;

      if ((port !== 0) && (port < min || port > max)) {
        window.alert(
          port + '\n' +
          'Port cannot be less than ' + min + ' or greater than ' + max +
          '\nSetting Port number to 0.'
        );
        return 0;
      } else {
        return port;
      }
    },
    validateNumConnections: function(start, end, numConnections) {
      numConnections = Number(numConnections);
      start = Number(start);
      end = Number(end);

      var potentialconnections = end - start + 1;

      if (start === 0 && end === 0) {
        return numConnections;
      } else if (potentialconnections < 0 || numConnections < 0) {
        window.alert(
          'Number of tunnel connections cannot be less than 0.' +
          '\nSetting Connection number to 0.'
        );
        return 0;
      } else if (numConnections > potentialconnections) {
        window.alert(
          'The max amount of tunnels in port range ' +
          start + '-' + end + ' is ' + potentialconnections + '.' +
          '\nSetting Connection number to ' + potentialconnections
        );
        return potentialconnections;
      } else {
        return numConnections;
      }
    },
    validateEndPort: function(start, end) {
      start = Number(start);
      end = this.validatePort(end);

      if (start === 0 ) {
        return 0;
      }

      if (end < start) {
        window.alert(
          'The End TCP port may not be lower than the Start TCP port.' +
          '\nDefaulting to equal the Start TCP port.'
        );
        return start;
      } else {
        return end;
      }
    },
    validate: function() {
      var tab = this.userdata.tabs[this.current];

      tab.network.port = this.validatePort(tab.network.port);
      tab.tunnels.tcpPort = this.validatePort(tab.tunnels.tcpPort);
      tab.tunnels.startPort = this.validatePort(tab.tunnels.startPort);

      tab.tunnels.endPort = this.validateEndPort(
        tab.tunnels.startPort,
        tab.tunnels.endPort
      );

      tab.tunnels.numConnections = this.validateNumConnections(
        tab.tunnels.startPort,
        tab.tunnels.endPort,
        tab.tunnels.numConnections
      );

      this.changeSettings();
    },
    changeSettings: function() {
      ipc.send('appSettingsChanged', JSON.stringify(userdata.toObject()));
      userdata.saveConfig(function(err) {
        if (err) {
          return window.alert(err.message);
        }
      });
    },
    openLogFolder: function() {
      shell.openExternal('file://' + this.userdata.appSettings.logFolder);
    },
    selectLogFolder: function() {
      ipc.send('selectLogFolder');
    }
  },
  ready: function() {
    var self = this;
    //check for OS-specific boot launch option
    ipc.send('checkBootSettings');
    ipc.on('checkAutoLaunchOptions', function(ev, isEnabled) {
      self.userdata.appSettings.launchOnBoot = isEnabled;
      userdata.saveConfig(function(err) {
        if (err) {
          return window.alert(err.message);
        }
      });
    });
    ipc.on('logFolderSelected', function(ev, path) {
      self.userdata.appSettings.logFolder = path[0];
      ipc.send('appSettingsChanged', JSON.stringify(userdata.toObject()));
    });
    //remove default bootstrap UI dropdown close behavior
    $('#app-settings > .dropdown-menu input,' +
      '#app-settings > .dropdown-menu label')
      .on('click', function(e) {
        e.stopPropagation();
      }
    );
  },
  beforeDestroy: function() {
    $('#app-settings > .dropdown-menu input,' +
      '#app-settings > .dropdown-menu label').off('click');
  }
});

// appSettings.current updates to be equal to main.current
main.$watch('current', function(val) {
  appSettings.current = val;
});

/**
 * Footer View
 */
var footer = new Vue({
  el: '#footer',
  data: {
    userdata: userdata._parsed
  },
  methods: {
    openLogFolder: function() {
      shell.openExternal('file://' + this.userdata.appSettings.logFolder);
    }
  }
});

/**
 * Terms View
 */
var terms;
terms = new Vue({
  el: '#terms',
  data: {
  },
  methods: {
    accepted: function() {
      localStorage.setItem('terms', JSON.stringify({ accepted: true }));
    }
  }
});

/**
 * Expose view objects
 * #exports
 */
module.exports = {
  updater: updater,
  about: about,
  appSettings: appSettings,
  main: main,
  footer: footer
};
