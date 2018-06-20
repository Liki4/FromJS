import { babelPlugin, LevelDBLogServer } from "@fromjs/core";
import { traverse } from "./src/traverse";
import StackFrameResolver, {
  ResolvedStackFrame
} from "./src/StackFrameResolver";
import * as fs from "fs";
import * as prettier from "prettier";
import * as Babel from "babel-core";
import * as crypto from "crypto";
import * as path from "path";
import * as express from "express";
import * as bodyParser from "body-parser";
import * as WebSocket from "ws";
import * as http from "http";
import { createProxy } from "./backend.createProxy";
import { BackendOptions } from "./BackendOptions";
import { HtmlToOperationLogMapping } from "@fromjs/core";
import { template } from "lodash";
import * as ui from "@fromjs/ui";
import { LocStore } from "./LocStore";
import * as getFolderSize from "get-folder-size";
import * as responseTime from "response-time";

let uiDir = require
  .resolve("@fromjs/ui")
  .split("/")
  .slice(0, -1)
  .join("/");
let coreDir = require
  .resolve("@fromjs/core")
  .split("/")
  .slice(0, -1)
  .join("/");
let startPageDir = path.resolve(__dirname + "/../start-page");

function ensureDirectoriesExist(options: BackendOptions) {
  const directories = [
    options.sessionDirectory,
    options.getCertDirectory(),
    options.getTrackingDataDirectory()
  ];
  directories.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir);
    }
  });
}

const LOG_PERF = true;
const DELETE_EXISTING_LOGS_AT_START = false;

export default class Backend {
  constructor(options: BackendOptions) {
    if (DELETE_EXISTING_LOGS_AT_START) {
      console.log(
        "deleting existing log data, this makes sure perf data is more comparable... presumably leveldb slows down with more data"
      );
      require("rimraf").sync(options.getLocStorePath());
      require("rimraf").sync(options.getTrackingDataDirectory());
    }
    ensureDirectoriesExist(options);

    getFolderSize(options.sessionDirectory, (err, size) => {
      console.log("Session size: ", (size / 1024 / 1024).toFixed(2) + " MB");
    });

    let sessionConfig;
    function saveSessionConfig() {
      fs.writeFileSync(
        options.getSessionJsonPath(),
        JSON.stringify(sessionConfig, null, 4)
      );
    }
    if (fs.existsSync(options.getSessionJsonPath())) {
      const json = fs.readFileSync(options.getSessionJsonPath()).toString();
      sessionConfig = JSON.parse(json);
    } else {
      sessionConfig = {
        accessToken: crypto.randomBytes(32).toString("hex")
      };
      saveSessionConfig();
    }

    var { bePort, proxyPort } = options;

    const app = express();

    if (LOG_PERF) {
      app.use(
        responseTime((req, res, time) => {
          console.log(req.method, req.url, time + "ms");
        })
      );
    }

    app.use(bodyParser.json({ limit: "250mb" }));
    const server = http.createServer(app);
    const wss = new WebSocket.Server({ server });

    wss.on("connection", (ws: WebSocket) => {
      ws.send(
        JSON.stringify({
          type: "connected"
        })
      );
    });

    // "Access-Control-Allow-Origin: *" allows any website to send data to local server
    // but that might be bad, so limit access to code generated by Babel plugin
    app.verifyToken = function verifyToken(req) {
      const { authorization } = req.headers;
      const { accessToken } = sessionConfig;
      if (authorization !== accessToken) {
        throw Error(
          "Token invalid: " + authorization + " should be " + accessToken
        );
      }
    };

    function getProxy() {
      return proxyInterface;
    }

    setupUI(options, app, wss, getProxy);
    let { storeLocs } = setupBackend(options, app, wss, getProxy);

    let proxyInterface;
    createProxy({
      accessToken: sessionConfig.accessToken,
      options,
      storeLocs
    }).then(pInterface => {
      proxyInterface = pInterface;
      "justtotest" && getProxy();
      if (options.onReady) {
        options.onReady();
      }
    });

    ["/storeLogs", "/inspect", "/inspectDOM"].forEach(path => {
      // todo: don't allow requests from any site
      app.options(path, allowCrossOriginRequests);
    });

    server.listen(bePort, () =>
      console.log("Server listening on port " + bePort)
    );
  }
}

function setupUI(options, app, wss, getProxy) {
  let isInspectingDemoApp = true;
  function setIsInspectingDemoApp(req) {
    const ref = req.headers.referer;
    isInspectingDemoApp = !!(
      ref && ref.includes("http://localhost:" + options.bePort + "/start/")
    );
  }

  app.get("/", (req, res) => {
    let html = fs.readFileSync(uiDir + "/index.html").toString();
    html = html.replace(/BACKEND_PORT_PLACEHOLDER/g, options.bePort.toString());
    html = html.replace(
      /IS_INSPECTING_DEMO_APP_PLACEHOLDER/,
      isInspectingDemoApp.toString()
    );
    res.send(html);
  });

  app.get("/start", (req, res) => {
    let html = fs.readFileSync(startPageDir + "/index.html").toString();
    const appJSCode = fs.readFileSync(startPageDir + "/app.js").toString();
    const escapedAppJSCode = template("<%- code %>")({ code: appJSCode });
    html = html.replace("APP_JS_CODE", escapedAppJSCode);
    res.send(html);
  });

  app.use(express.static(uiDir));
  app.use("/start", express.static(startPageDir));

  function getDomToInspectMessage() {
    if (!domToInspect) {
      return {
        err: "Backend has no selected DOM to inspect"
      };
    }

    const mapping = new HtmlToOperationLogMapping((<any>domToInspect).parts);

    const html = mapping.getHtml();
    let goodDefaultCharIndex = 0;
    const charIndexWhereTextFollows = html.search(/>[^<]/) + 1;
    if (
      charIndexWhereTextFollows !== -1 &&
      mapping.getOriginAtCharacterIndex(charIndexWhereTextFollows)
    ) {
      goodDefaultCharIndex = charIndexWhereTextFollows;
    }

    return {
      html: (<any>domToInspect).parts.map(p => p[0]).join(""),
      charIndex: goodDefaultCharIndex,
      isInspectingDemoApp
    };
  }

  let domToInspect = null;
  app.get("/inspectDOM", (req, res) => {
    res.end(JSON.stringify(getDomToInspectMessage()));
  });
  app.post("/inspectDOM", (req, res) => {
    app.verifyToken(req);

    res.set("Access-Control-Allow-Origin", "*");
    res.set(
      "Access-Control-Allow-Headers",
      "Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With"
    );

    setIsInspectingDemoApp(req);

    domToInspect = req.body;

    broadcast(
      wss,
      JSON.stringify({
        type: "inspectDOM",
        ...getDomToInspectMessage()
      })
    );

    res.end("{}");
  });

  let logToInspect = null;
  app.get("/inspect", (req, res) => {
    res.end(
      JSON.stringify({
        logToInspect,
        isInspectingDemoApp
      })
    );
  });
  app.post("/inspectDomChar", (req, res) => {
    if (!domToInspect) {
      res.status(500);
      res.json({
        err: "Backend has no selected DOM to inspect"
      });
      res.end();
      return;
    }

    const mapping = new HtmlToOperationLogMapping((<any>domToInspect).parts);
    const mappingResult: any = mapping.getOriginAtCharacterIndex(
      req.body.charIndex
    );

    if (!mappingResult.origin) {
      res.end(
        JSON.stringify({
          logId: null
        })
      );
      return;
    }

    const origin = mappingResult.origin;

    let offset = 0;
    if (
      origin.offsetAtCharIndex &&
      origin.offsetAtCharIndex[mappingResult.charIndex]
    ) {
      offset = origin.offsetAtCharIndex[mappingResult.charIndex];
    }
    let charIndex =
      mappingResult.charIndex +
      origin.inputValuesCharacterIndex[0] -
      origin.extraCharsAdded +
      offset;

    res.end(
      JSON.stringify({
        logId: mappingResult.origin.trackingValue,
        charIndex
      })
    );
  });
  app.post("/inspect", (req, res) => {
    allowCrossOrigin(res);

    app.verifyToken(req);
    logToInspect = req.body.logId;
    res.end("{}");

    setIsInspectingDemoApp(req);

    broadcast(
      wss,
      JSON.stringify({
        type: "inspectOperationLog",
        operationLogId: logToInspect,
        isInspectingDemoApp
      })
    );
  });
}

function setupBackend(options: BackendOptions, app, wss, getProxy) {
  const logServer = new LevelDBLogServer(options.getTrackingDataDirectory());
  const locStore = new LocStore(options.getLocStorePath());

  app.get("/jsFiles/compileInBrowser.js", (req, res) => {
    const code = fs
      .readFileSync(coreDir + "/../compileInBrowser.js")
      .toString();
    res.end(code);
  });
  app.get("/jsFiles/babel-standalone.js", (req, res) => {
    const code = fs
      .readFileSync(coreDir + "/../babel-standalone.js")
      .toString();
    res.end(code);
  });

  app.post("/storeLogs", (req, res) => {
    app.verifyToken(req);

    res.set("Access-Control-Allow-Origin", "*");
    res.set(
      "Access-Control-Allow-Headers",
      "Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With"
    );

    const startTime = new Date();
    logServer.storeLogs(req.body.logs, function() {
      const timePassed = new Date().valueOf() - startTime.valueOf();
      const timePer1000 =
        Math.round(timePassed / req.body.logs.length * 1000 * 10) / 10;
      if (LOG_PERF) {
        console.log(
          "storing logs took " +
            timePassed +
            "ms, per 1000 logs: " +
            timePer1000 +
            "ms"
        );
      }
    });

    req.body.evalScripts.forEach(function(evalScript) {
      getProxy().registerEvalScript(evalScript);
    });

    // fs.writeFileSync("logs.json", JSON.stringify(logServer._storedLogs));
    // console.log("stored logs", req.body.logs.length);

    res.end(JSON.stringify({ ok: true }));
  });

  app.post("/loadLog", (req, res) => {
    // crude way to first wait for any new logs to be sent through...
    setTimeout(function() {
      // console.log(Object.keys(internalServerInterface._storedLogs));
      console.log(req.body);
      logServer.loadLog(req.body.id, function(err, log) {
        res.end(JSON.stringify(log));
      });
    }, 500);
  });

  app.post("/traverse", (req, res) => {
    const { logId, charIndex } = req.body;
    const tryTraverse = (previousAttempts = 0) => {
      logServer.hasLog(logId, hasLog => {
        if (hasLog) {
          finishRequest();
        } else {
          const timeout = 250;
          const timeElapsed = timeout * previousAttempts;
          if (timeElapsed > 2000) {
            res.status(500);
            res.end(
              JSON.stringify({
                err: "Log not found - might still be saving data"
              })
            );
          } else {
            setTimeout(() => {
              tryTraverse(previousAttempts + 1);
            }, timeout);
          }
        }
      });
    };

    const finishRequest = async function finishRequest() {
      let steps;
      try {
        steps = await traverse(
          {
            operationLog: logId,
            charIndex: charIndex
          },
          [],
          logServer
        );
      } catch (err) {
        res.status(500);
        res.end(
          JSON.stringify({
            err: "Log not found in backend"
          })
        );
      }

      res.end(JSON.stringify({ steps }));
    };

    tryTraverse();
  });

  const resolver = new StackFrameResolver({ proxyPort: options.proxyPort });

  app.post("/resolveStackFrame", (req, res) => {
    // const frameString = req.body.stackFrameString;

    const operationLog = req.body.operationLog;

    // use loc if available because sourcemaps are buggy...
    if (operationLog.loc) {
      locStore.getLoc(operationLog.loc, loc => {
        resolver.resolveFrameFromLoc(loc).then(rr => {
          res.end(JSON.stringify(rr));
        });
      });
    } else {
      res.status(500);
      res.end(
        JSON.stringify({
          err:
            "not supporting non locs anymore, don't use sourcemap (" +
            operationLog.operation +
            ")"
        })
      );
      // resolver
      //   .resolveFrame(frameString)
      //   .then(rr => {
      //     res.end(JSON.stringify(rr));
      //   })
      //   .catch(err => {

      //   });
    }
  });

  app.post("/prettify", (req, res) => {
    res.end(
      JSON.stringify({
        code: prettier.format(req.body.code, { parser: "babylon" })
      })
    );
  });

  app.post("/instrument", (req, res) => {
    const code = req.body.code;

    getProxy()
      .instrumentForEval(code)
      .then(babelResult => {
        res.end(
          JSON.stringify({ instrumentedCode: babelResult.instrumentedCode })
        );
      });
  });

  return {
    storeLocs: locs => {
      locStore.write(locs, function() {});
    }
  };
}

function broadcast(wss, data) {
  wss.clients.forEach(function each(client) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

function allowCrossOriginRequests(req, res) {
  allowCrossOrigin(res);
  res.end();
}

function allowCrossOrigin(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With"
  );
}

export { BackendOptions };
