Logger.log("Running state.js");
var Client = require('ssh2').Client;
const EventEmitter = require('events');
const readline = require('readline');

module.exports = class Device extends EventEmitter{
  constructor(successConnectCallback, disconnectCallback, failureConnectCallback){
    super();
    var self = this;
    //self = this;
    this.controllerConnected = false;
    this.soloConnected = false;
    this.versions = {
      sololink_version: " – ",
      gimbal_version: " – ",
      ak_version: " – ",
      shotmanager_version: " – ",
      pixhawk_version: " – ",
      controller_version: " – ",
      ssid: " – ",
      password: " – "
    }
    this.controller_connection = new Client();
    this.solo_connection = new Client();


// Controller connection config
    this.controller_connection_params = {
        host: '10.1.1.1',
        port: 22,
        username: 'root',
        password: 'TjSDBkAu',
        readyTimeout: 2000,
        keepaliveInterval: 2000
    }

    this.controller_connection.on('ready', function(er) {
        if(er){
          Logger.log("Connection ready but error with controller");
        } else {
            Logger.log('Controller :: ready');
            self.controllerConnected = true;
            successConnectCallback("controller");
            self.get_controller_version();
        }
    });
    this.controller_connection.on('error', function(er){
        Logger.log("Error connecting to controller");
        self.controller_connection.end(); //end the connection if we have an error
        if (er.toString() == "Error: Keepalive timeout"){  // if the connection times out, the wifi network got switched or device was shut off
          Logger.log("Timeout; controller must have disconnected");
          // If controller timed out, Solo won't be connected
          self.disconnect();
          disconnectCallback('controller', 'Controller and Solo');
        } else {
          failureConnectCallback("controller");
        }
    });

    this.controller_connection.on('close', function(){
        Logger.log("Connection to controller closed");
        disconnectCallback('controller');
    });
    this.controller_connection.on('exit', function(){
        Logger.log("Connection to controller exited");
        disconnectCallback('controller');
    });

    // Solo connection config
    this.solo_connection_params = {
        host: '10.1.1.10',
        port: 22,
        username: 'root',
        password: 'TjSDBkAu',
        readyTimeout: 2000,
        keepaliveInterval: 2000
    }

    this.solo_connection.on('ready', function(er) {
        if(er){
          Logger.log("Error connecting to solo");
        } else {
            Logger.log('Solo :: ready');
            self.soloConnected = true;
            successConnectCallback('solo');
            //When the Solo connection has been established, get the versions
            self.get_sololink_version();
            self.get_pixhawk_version();
            // Get GoPro gimbal version, if there is one
            self.get_version_from_file('/AXON_VERSION', 'gimbal_version');
            // Get AK version, if AK installed
            self.get_version_from_file('/AK_VERSION', 'ak_version');
            // Get shotmanager version
            self.get_version_from_file('/log/shotlog.log', 'shotmanager_version');
            self.get_wifi_info();
        }
    });

    this.solo_connection.on('error', (er)=>{
        Logger.log("Error connecting to solo");
        if (er.toString() == "Error: Keepalive timeout"){
          if (this.controllerConnected){
            disconnectCallback('solo', "Solo");  // Controller is connected but Solo got shutdown or battery pulled
          }
        } else if (this.controllerConnected){  // controller is connected and it wasn't a keepalive timeout - we weren't able to connect
            failureConnectCallback("solo");
            self.solo_connection.end();
        }
    });

    this.solo_connection.on('close', function(){
        Logger.log("Connection to Solo closed");
        disconnectCallback('solo');
    });
    this.solo_connection.on('exit', function(){
      Logger.log("Connection to solo exited");
      failureConnectCallback('solo');
    });

    this.solo_connection.on('end', function(){
      Logger.log("Connection to solo exited");
      disconnectCallback('solo');
    });
}

// General methods
  connect_to_controller() {
    Logger.log("connect_to_controller called");
    this.controller_connection.connect(this.controller_connection_params);
  };
  connect_to_solo(){
    Logger.log("Connect to solo called");
    this.solo_connection.connect(this.solo_connection_params);
  };

  disconnect(){
    Logger.log("disconnect()");
    if (this.controllerConnected){
      this.controller_connection.end();
      this.controllerConnected = false;
    }
    if (this.soloConnected) {
      this.solo_connection.end();
      this.soloConnected = false;
    }
  }

  sololink_config_request(connection, command, callback){
    //takes SSH connection and returns response from sololink_config
    Logger.log("sololink_config_request ", command);
    var version = '';
    connection.exec(command, function(err, stream){
      stream.on('data', function(data, stderr){
        if(stderr){
          Logger.log(command + " failed: " + stderr);
        }
        version = data.toString().trim();
        callback(version);
      });
    });
  }

  get_wifi_info(){
    Logger.log("get_controller_version()");
    var self = this;
    this.sololink_config_request(this.controller_connection, 'sololink_config --get-wifi-ssid', function(ssid){
      self.versions.ssid = ssid;
      self.sololink_config_request(self.controller_connection, 'sololink_config --get-wifi-password', function(password){
        self.versions.password = password;
        self.emit('updated_versions');
      });
    });
  }

  get_controller_version(){
    Logger.log("get_controller_version()");
    var self = this;
    var command = 'sololink_config --get-version artoo';
    this.sololink_config_request(this.controller_connection, command, function(version){
      self.versions.controller_version = version;
      self.emit('updated_versions');
    });
  };

  get_sololink_version(){
    Logger.log("get_sololink_version()");
    var command = 'sololink_config --get-version sololink';
    var self = this;
    this.sololink_config_request(this.solo_connection, command, function(version){
      self.versions.sololink_version = version;
      self.emit('updated_versions');
    });
  }

  get_pixhawk_version(){
    Logger.log("get_pixhawk_version()");
    var self = this;
    var command = 'sololink_config --get-version pixhawk';
    this.sololink_config_request(this.solo_connection, command, function(version){
      self.versions.pixhawk_version = version;
      self.emit('updated_versions');
    });
  }

  get_version_from_file(filename, component){
    //We can't get gimbal version from sololink_config :(
    //Pull it from a file instead
    Logger.log("get_version_from_file");
    Logger.log(filename);
    Logger.log(component);
    var self = this;
    let out_version = '';

    this.solo_connection.sftp(function(err, sftp){
      if (err) return;
      sftp.stat(filename, (err, stat)=>{
        if (err) {  // No gimbal attached. We don't have a GoPro gimbal
          Logger.log(`No file for ${filename}`);
          self.versions[component] = "Not available";
          self.emit('updated_versions');
        } else { // The gimbal version file exists. Pull it and parse it.
            let fileRead = sftp.createReadStream(filename);
            let data = '';
            let line = readline.createInterface({
              input: fileRead,
              output:null
            });

            line.on('line', (line)=>{
              if (data.length < 1){
                data = line;
              }
            });

            fileRead.on('end', ()=>{
              out_version = data.toString().match(/(\d.\d.\d)/)[0];
              Logger.log("Regex version number: " + out_version);
              self.versions[component] = out_version;
              Logger.log(self.versions.ak_version);
              self.emit('updated_versions');
            });
          };
      });
    });
  };
};
