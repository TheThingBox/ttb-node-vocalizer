module.exports = function(RED) {
  "use strict";

  var fs = require('fs');
  var http = require("follow-redirects").http;
  var urllib = require("url");
  var cache = require("ttb-cache-api");
  var mqtt = require("mqtt");
  var Mustache = require("mustache");

  function Vocalizer(n) {
    RED.nodes.createNode(this, n);

    this.text = n.text;
    this.lang = n.lang;
    this.topic = "sound/play";

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

      var lang = msg.lang || node.lang;
      var path = cacheDir+Math.random().toString(36).substr(2, 9)+".mp3",
        key  = lang+"-"+text.toLowerCase().replace(/  /g,' ');

      var fileToAdd = {
        "path": path,
        "key": key
      }

      var checkFile = node.cache.check(fileToAdd);

      if(checkFile.exist){
        node.client.publish(node.topic,JSON.stringify({"payload":checkFile.path}));
      } else {
        var payload = JSON.stringify({
          "url": "http://mythingbox.io/api/V2/vocalize/V2",
          "payload":{
            "lang":lang,
            "text":encodeURIComponent(text)
          },
          "dontdecrypt":"true"
        });
        var url = "http:///cloud";
        var opts = urllib.parse(url);
        opts.method = "POST";
        opts.headers = {};
        opts.headers['content-type'] = "application/json";
        opts.headers['content-length'] = Buffer.byteLength(payload);
        var req = http.request(opts,function(res) {
          msg.statusCode = res.statusCode;
          msg.payload = "";
          res.on('data',function(chunk) {
            msg.payload += chunk;
          });
          res.on('end',function() {
            var data = JSON.parse(msg.payload).data;
            try{
              data = JSON.parse(data);
            }catch(e){
            }

            if(data.hasOwnProperty("needAccount")){
              node.send({'statusCode' : data.statusCode, 'message' : "You need an account to use our services.", 'payload' : null});
              return;
            }

            if(data.hasOwnProperty("needActivation")){
              node.send({'statusCode' : data.statusCode, 'message' : "You need to activate your account to use our services.", 'payload' : null});
              return;
            }

            if (data.statusCode == "0" || data.statusCode == "4" || data.statusCode == "1") {
              var mp3Path = node.cache.add(fileToAdd);
              var mp3Buffer = new Buffer(data.payload, 'binary');
              fs.open(mp3Path, 'w',function(err, fd){
                fs.write(fd,mp3Buffer,0,mp3Buffer.length,0,function(err, written, buffer){
                  fs.closeSync(fd);
                  node.client.publish(node.topic,JSON.stringify({"payload":mp3Path}));
                })
              })

              if(data.statusCode == "1") {
                node.warn("Quota is exceeded");
              }

              var text = "";

              if(data.subInfos.conso % 1 == 0) {
                data.subInfos.conso = parseInt(data.subInfos.conso);
              }

              var outPackage = data.subInfos.outPackage;

              if(outPackage.total % 1 == 0) {
                outPackage.total = parseInt(outPackage.total);
              }

              if(data.subInfos.limit == "0") {
                text += "Vous avez une consommation de "+data.subInfos.conso+" secondes de "+data.subInfos.type+", pour une utilisation illimitée.";
              } else {
                text += "Vous avez une consommation de "+data.subInfos.conso+" secondes de "+data.subInfos.type+" pour une limite de "+data.subInfos.limit+".";
              }


              if(typeof outPackage.unitPrice != "undefined") {
                text += "Vous avez consommé "+outPackage.total+" secondes de "+data.subInfos.type+" en hors forfait. Le prix unitaire en hors forfait est de : "+outPackage.unitPrice;
              }

              node.send({'statusCode' : data.statusCode, 'message' : text, 'payload' : data.subInfos})

            }
            if(data.statusCode == "2") {
              node.warn("Not included in the subscription");
            }

          });
        });
        req.on('error',function(err) {
          msg.payload = err.toString() + " : " + url;
          msg.statusCode = err.code;
          node.send(msg);
        });
        req.write(payload);
        req.end();
      }
    });

    this.on('close', function() {
      if (node.client) {
        node.client.end();
      }
    });

  }
  RED.nodes.registerType("vocalizer", Vocalizer);
}
