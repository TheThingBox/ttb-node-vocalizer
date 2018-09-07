module.exports = function(RED) {
  "use strict";

  var http = require("follow-redirects").http;
  var uuid = require("uuid/v4");
  var mqtt = require("mqtt");
  var urllib = require("url");
  var Mustache = require("mustache");
  var fs = require('fs');
  var cache = require("ttb-cache-api");

  function Vocalizer(n) {
    RED.nodes.createNode(this, n);

    this.text = n.text;
    this.lang = n.lang;
    this.topic = "sound/play";
    this.protocol = n.protocol;

    var lastOk = {}

    this.client = mqtt.connect("mqtt://mosquitto:1883");

    this.client.on("close",function() {
      node.status({fill:"red",shape:"ring",text:"disconnected"});
    });
    this.client.on("connect",function() {
      node.status({fill:"green",shape:"dot",text:"connected"});
    });

    var cacheDir  = "/root/userdir/vocalizer/";
    var cacheSize = 1*Math.pow(10, 8);
    this.cache = new cache(cacheSize, cacheDir+"index.json", cacheDir);

    var node = this;

    this.on('input', function(msg) {
      var text = node.text;
      var availableProperties = ["message", "text", "payload"]
      var propertyUsed = null;
      var cloneOfMsg = RED.util.cloneMessage(msg);
      if(!text){
        for( var i in availableProperties){
          if(msg.hasOwnProperty(availableProperties[i]) && msg[availableProperties[i]]){
            propertyUsed = availableProperties[i];
            break;
          }
        }
        if(propertyUsed === null){
          node.warn("Cannot vocalize an empty payload");
          return;
        }
        text = msg[propertyUsed];
        delete cloneOfMsg[propertyUsed];
      }

      text = Mustache.render(text, cloneOfMsg);

      var protocol = msg.protocol || node.protocol || 'http';
      var lang = msg.lang || node.lang;
      var path = cacheDir+Math.random().toString(36).substr(2, 9)+".mp3";
      var key = lang+"-"+text.toLowerCase().replace(/  /g,' ');

      var fileToAdd = {
        "path": path,
        "key": key
      }

      var checkFile = node.cache.check(fileToAdd);

      function processAnswer(payload){
        var data = "";
        var err = false;
        try{
          payload = JSON.parse(payload);
        }catch(e){}
        var _payload = payload
        try{
          payload = JSON.parse(payload.payload);
        }catch(e){
          payload = payload.payload;
        }
        if(!payload){
          return {}
        }
        if(_payload.hasOwnProperty("error")){
            data = _payload.payload;
            err = true;
        } else if(payload.hasOwnProperty("needAccount")){
          data = "You need an account to use our services.";
          err = true;
        } else if(payload.hasOwnProperty("needActivation")){
          data = "You need to activate your account to use our services.";
          err = true;
        } else if(payload.statusCode == "2"){
          data = "Vocalizer is not included in the subscription";
          err = true;
        } else{
          if(payload.statusCode == "1") {
            data = "Quota is exceeded\n";
            err = true;
          }

          if(payload.subInfos.conso % 1 == 0) {
            payload.subInfos.conso = parseInt(payload.subInfos.conso);
          }

          var outPackage = payload.subInfos.outPackage;

          if(outPackage.total % 1 == 0) {
            outPackage.total = parseInt(outPackage.total);
          }

          if(payload.subInfos.limit == "0") {
            data += "Vous avez une consommation de "+payload.subInfos.conso+" secondes de "+payload.subInfos.type+", pour une utilisation illimitée.";
          } else {
            data += "Vous avez une consommation de "+payload.subInfos.conso+" secondes de "+payload.subInfos.type+" pour une limite de "+payload.subInfos.limit+".";
          }

          if(typeof outPackage.unitPrice != "undefined") {
            data += "\nVous avez consommé "+outPackage.total+" secondes de "+payload.subInfos.type+" en hors forfait. Le prix unitaire en hors forfait est de : "+outPackage.unitPrice;
          }


          if (payload.statusCode == "0" || payload.statusCode == "4" || payload.statusCode == "1") {
            var mp3Path = node.cache.add(fileToAdd);
            var mp3Buffer = new Buffer(payload.payload, 'binary');
            fs.open(mp3Path, 'w',function(err, fd){
              fs.write(fd,mp3Buffer,0,mp3Buffer.length,0,function(err, written, buffer){
                fs.closeSync(fd);
                node.client.publish(node.topic,JSON.stringify({"payload":mp3Path}));
              })
            })
          }

        }

        return {
          payload: payload.subInfos || null,
          statusCode: payload.statusCode,
          message: data,
          warn: err
        }
      }

      function handle(data, err){
        var answer = {}
        if(err){
          node.warn(data)
          answer.warn = true
          answer.payload = data
          answer.statusCode = err.code
          answer.message = err.toString()
        } else {
          try {
            answer = processAnswer(data)
          } catch(e){
            msg.payload = null
            node.send(msg);
          }
        }

        if(!answer){
          return
        }

        if(answer.warn){
          node.warn(answer.message);
        }

        msg.payload = answer.payload;
        msg.statusCode = answer.statusCode;
        msg.message = answer.message;

        lastOk.payload = answer.payload;
        lastOk.statusCode = answer.statusCode;
        lastOk.message = answer.message;

        node.send(msg);
      }

      if(checkFile.exist){
        node.client.publish(node.topic,JSON.stringify({"payload":checkFile.path}));
        var lastData = lastOk
        if(lastData.payload && lastData.payload.currentConso) {
          lastData.payload.currentConso = 0
        }
        msg = Object.assign({}, msg, lastData)
        node.send(msg);
      } else {
        switch(protocol){
          case 'http' :
            sendHTTP({
              "dontdecrypt": true,
              "url": "http://mythingbox.io/api/services/vocalizer",
              "payload":{
                "lang":lang,
                "text":encodeURIComponent(text)
              }
            }, handle);
            break;
          case 'mqtt' :
            var msgid = uuid();
            sendMQTT({
              "dontdecrypt": true,
              "topic": "api/services/vocalizer/{{{ttb_id}}}/"+msgid,
              "backtopic": "receive/"+msgid,
              "payload":{
                "lang":lang,
                "text":encodeURIComponent(text)
              }
            }, handle);
            break;
          default:
        }
      }
    });

    this.on('close', function() {
      if (node.client) {
        node.client.end();
      }
    });
  }
  RED.nodes.registerType("vocalizer", Vocalizer);

  function sendHTTP(message, callback){
    var url = "http:///cloud";
    var opts = urllib.parse(url);
    var code;
    var payload;

    try{
      message = JSON.stringify(message);
    } catch(e){}

    opts.method = "POST";
    opts.headers = {};
    opts.headers['content-type'] = "application/json";
    opts.headers['content-length'] = Buffer.byteLength(message);

    var req = http.request(opts,function(res) {
      code = res.statusCode;
      payload = "";
      res.on('data',function(chunk) {
        payload += chunk;
      });
      res.on('end',function() {
        callback(payload)
      });
    });
    req.on('error',function(err) {
      callback(err.toString() + " : " + url, err)
    });
    req.write(message);
    req.end();
  }

  function sendMQTT(message, callback){
    var backtopic = message.backtopic
    try{
      message = JSON.stringify(message);
    } catch(e){}

    var client  = mqtt.connect("mqtt://mosquitto:1883");

    client.on('message', function (topic, payload) {
      if(topic === backtopic){
        callback(payload)
        client.end()
      }
    })

    client.on('connect', function () {
      client.subscribe(backtopic , 0, function(err, granted){
        if(!err){
          client.publish('cloud', message);
        }
      })
    })
  }
}
