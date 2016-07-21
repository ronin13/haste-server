var http = require('http');
var url = require('url');
var fs = require('fs');
var https = require('https');

var LEX = require('letsencrypt-express').testing();
var express = require('express');

var winston = require('winston');
var connect = require('connect');
var route = require('connect-route');
var connect_st = require('st');
var connect_rate_limit = require('connect-ratelimit');

var DocumentHandler = require('./lib/document_handler');

// Load the configuration and set some defaults
var config = JSON.parse(fs.readFileSync('./config.js', 'utf8'));
config.port = process.env.PORT || config.port || 7777;
config.host = process.env.HOST || config.host || 'localhost';
config.local = process.env.LOCAL || 'remote';

if (config.local === 'local') {
    var options = {
        key: fs.readFileSync('certs/key.pem'),
        cert: fs.readFileSync('certs/cert.pem')
    };
}

// Set up the logger
if (config.logging) {
  try {
    winston.remove(winston.transports.Console);
  } catch(er) { }
  var detail, type;
  for (var i = 0; i < config.logging.length; i++) {
    detail = config.logging[i];
    type = detail.type;
    delete detail.type;
    winston.add(winston.transports[type], detail);
  }
}

// build the store from the config on-demand - so that we don't load it
// for statics
if (!config.storage) {
  config.storage = { type: 'file' };
}
if (!config.storage.type) {
  config.storage.type = 'file';
}

var Store, preferredStore;

if (process.env.REDISTOGO_URL && config.storage.type === 'redis') {
  var redisClient = require('redis-url').connect(process.env.REDISTOGO_URL);
  Store = require('./lib/document_stores/redis');
  preferredStore = new Store(config.storage, redisClient);
}
else {
  Store = require('./lib/document_stores/' + config.storage.type);
  preferredStore = new Store(config.storage);
}

// Compress the static javascript assets
if (config.recompressStaticAssets) {
  var jsp = require("uglify-js").parser;
  var pro = require("uglify-js").uglify;
  var list = fs.readdirSync('./static');
  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    var orig_code, ast;
    if ((item.indexOf('.js') === item.length - 3) &&
        (item.indexOf('.min.js') === -1)) {
      dest = item.substring(0, item.length - 3) + '.min' +
        item.substring(item.length - 3);
      orig_code = fs.readFileSync('./static/' + item, 'utf8');
      ast = jsp.parse(orig_code);
      ast = pro.ast_mangle(ast);
      ast = pro.ast_squeeze(ast);
      fs.writeFileSync('./static/' + dest, pro.gen_code(ast), 'utf8');
      winston.info('compressed ' + item + ' into ' + dest);
    }
  }
}

// Send the static documents into the preferred store, skipping expirations
var path, data;
for (var name in config.documents) {
  path = config.documents[name];
  data = fs.readFileSync(path, 'utf8');
  winston.info('loading static document', { name: name, path: path });
  if (data) {
    preferredStore.set(name, data, function(cb) {
      winston.debug('loaded static document', { success: cb });
    }, true);
  }
  else {
    winston.warn('failed to load static document', { name: name, path: path });
  }
}

// Pick up a key generator
var pwOptions = config.keyGenerator || {};
pwOptions.type = pwOptions.type || 'random';
var gen = require('./lib/key_generators/' + pwOptions.type);
var keyGenerator = new gen(pwOptions);

// Configure the document handler
var documentHandler = new DocumentHandler({
  store: preferredStore,
  maxLength: config.maxLength,
  keyLength: config.keyLength,
  keyGenerator: keyGenerator
});

//var app = connect();
var app = express();

// Rate limit all requests
if (config.rateLimits) {
  config.rateLimits.end = true;
  app.use(connect_rate_limit(config.rateLimits));
}

// first look at API calls
app.use(route(function(router) {
  // get raw documents - support getting with extension
  router.get('/raw/:id', function(request, response, next) {
    var skipExpire = !!config.documents[request.params.id];
    var key = request.params.id.split('.')[0];
    token = request.headers['x-token'].toString();
    if (documentHandler.validateToken(token, '996835855095-a2rm7pqlgihikeq2vmcu1ak28rrbc9n1.apps.googleusercontent.com' )) {
        winston.warn('Failed authentication');
        response.writeHead(403, { 'content-type': 'application/json' });
        response.end(
            JSON.stringify({ message: 'Failed authentication' })
        );
        return;
    }
    return documentHandler.handleRawGet(key, response, skipExpire);
  });
  // add documents
  router.post('/documents', function(request, response, next) {
    token = request.headers['x-token'].toString();
    if (documentHandler.validateToken(token, '996835855095-a2rm7pqlgihikeq2vmcu1ak28rrbc9n1.apps.googleusercontent.com')) {
        winston.warn('Failed authentication');
        response.writeHead(403, { 'content-type': 'application/json' });
        response.end(
            JSON.stringify({ message: 'Failed authentication' })
        );
        return;
    }
    winston.info('Proceeding with post');
    return documentHandler.handlePost(request, response);
  });
  // get documents
  router.get('/documents/:id', function(request, response, next) {
    var skipExpire = !!config.documents[request.params.id];
    console.dir(request.headers);
    token = request.headers['x-token'].toString();
    if (documentHandler.validateToken(token, '996835855095-a2rm7pqlgihikeq2vmcu1ak28rrbc9n1.apps.googleusercontent.com' )) {
        winston.warn('Failed authentication');
        response.writeHead(403, { 'content-type': 'application/json' });
        response.end(
            JSON.stringify({ message: 'Failed authentication' })
        );
        return;
    }
    return documentHandler.handleGet(
      request.params.id,
      response,
      skipExpire
    );
  });
}));

// Otherwise, try to match static files
app.use(connect_st({
  path: __dirname + '/static',
  content: { maxAge: config.staticMaxAge },
  passthrough: true,
  index: false
}));

// Then we can loop back - and everything else should be a token,
// so route it back to /
app.use(route(function(router) {
  router.get('/:id', function(request, response, next) {
    request.sturl = '/';
    next();
  });
}));

// And match index
app.use(connect_st({
  path: __dirname + '/static',
  content: { maxAge: config.staticMaxAge },
  index: 'index.html'
}));

//http.createServer(app).listen(config.port, config.host);

if (config.local === 'remote') {
    http.createServer(app).listen(config.port);
    winston.info('listening on ' + config.host + ':' + config.port);
} else if (config.local === 'local') {
    http.createServer(app).listen(config.port);
    https.createServer(options, app).listen(config.port+1);
    winston.info('listening on ' + config.host + ':' + config.port + 'and' + (config.port+1));
} else if (config.local === 'lex') {
    LEX.create({
    configDir: './lesconfig'                 // ~/letsencrypt, /etc/letsencrypt, whatever you want

    , onRequest: app                                    // your express app (or plain node http app)

    , letsencrypt: null                                 // you can provide you own instance of letsencrypt
                                                        // if you need to configure it (with an agreeToTerms
                                                        // callback, for example)

    , approveRegistration: function (hostname, cb) {    // PRODUCTION MODE needs this function, but only if you want
                                                        // automatic registration (usually not necessary)
                                                        // renewals for registered domains will still be automatic
        cb(null, {
        domains: [yaste1337.appspot.com]
        , email: 'me@rdprabhu.com'
        , agreeTos: true              // you
        });
    }
    }).listen([config.port], [config.port+1], function () {
        winston.info('listening on ' + config.host + ':' + config.port + 'and' + (config.port+1));
    });
}
