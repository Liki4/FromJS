


const str = __fromJSRawEval(`(function(){
  const ret = "a" + "b"
  __fromJSRegisterLuckyMatch(ret)
  return ret
})()`)
console.log("Inspect:" + __fromJSGetTrackingIndex(str))
__fromJSWaitForSendLogsAndExitNodeProcess()