export default `
(function () {
  var nextAckId = 1;

  function encode(event, data, ackId) {
    return JSON.stringify({ event: event, data: data == null ? null : data, ackId: ackId || null });
  }

  function decode(raw) {
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.event !== 'string') return null;
      return parsed;
    } catch (error) {
      return null;
    }
  }

  function makeSocket(options) {
    var opts = options || {};
    var listeners = {};
    var pendingAcks = {};
    var reconnectTimer = null;
    var reconnectAttempts = 0;
    var reconnectingAttempt = 0;
    var manualDisconnect = false;
    var reconnectionEnabled = opts.reconnection !== false;
    var reconnectionDelay = Number(opts.reconnectionDelay) > 0 ? Number(opts.reconnectionDelay) : 800;
    var reconnectionDelayMax = Number(opts.reconnectionDelayMax) > 0 ? Number(opts.reconnectionDelayMax) : 5000;
    var ackTimeout = Number(opts.ackTimeout) > 0 ? Number(opts.ackTimeout) : 10000;

    var socket = {
      connected: false,
      auth: opts.auth ? opts.auth : {},
      ws: null,
      on: function (event, handler) {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(handler);
        return socket;
      },
      off: function (event, handler) {
        if (!listeners[event]) return socket;
        listeners[event] = listeners[event].filter(function (item) { return item !== handler; });
        return socket;
      },
      emit: function (event, data, callback) {
        if (!socket.ws || socket.ws.readyState !== WebSocket.OPEN) {
          if (typeof callback === 'function') callback({ success: false, error: '连接未建立' });
          if (!manualDisconnect) socket.connect();
          return socket;
        }

        var ackId = typeof callback === 'function' ? 'ack-' + nextAckId++ : null;
        if (ackId) {
          pendingAcks[ackId] = {
            callback: callback,
            timer: setTimeout(function () {
              var pending = pendingAcks[ackId];
              if (!pending) return;
              delete pendingAcks[ackId];
              pending.callback({ success: false, error: '请求超时' });
            }, ackTimeout)
          };
        }
        socket.ws.send(encode(event, data, ackId));
        return socket;
      },
      connect: function () {
        if (socket.ws && (socket.ws.readyState === WebSocket.OPEN || socket.ws.readyState === WebSocket.CONNECTING)) return socket;
        manualDisconnect = false;
        var token = socket.auth && socket.auth.token ? socket.auth.token : '';
        var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        var url = protocol + '//' + window.location.host + '/ws?token=' + encodeURIComponent(token);
        socket.ws = new WebSocket(url);
        socket.ws.addEventListener('open', function () {
          var wasReconnecting = reconnectingAttempt > 0;
          var completedAttempt = reconnectingAttempt;
          socket.connected = true;
          clearReconnectTimer();
          reconnectAttempts = 0;
          reconnectingAttempt = 0;
          dispatch('connect');
          if (wasReconnecting) dispatch('reconnect', { attempt: completedAttempt });
        });
        socket.ws.addEventListener('message', function (event) {
          var message = decode(event.data);
          if (!message) return;
          if (message.event === 'ack' && message.data && message.data.ackId) {
            var pending = pendingAcks[message.data.ackId];
            if (pending) {
              delete pendingAcks[message.data.ackId];
              clearTimeout(pending.timer);
              pending.callback(message.data.payload);
            }
            return;
          }
          dispatch(message.event, message.data);
        });
        socket.ws.addEventListener('close', function () {
          socket.connected = false;
          dispatch('disconnect');
          if (!manualDisconnect) scheduleReconnect();
        });
        socket.ws.addEventListener('error', function () {
          dispatch('connect_error', new Error('连接失败'));
        });
        return socket;
      },
      disconnect: function () {
        manualDisconnect = true;
        clearReconnectTimer();
        if (socket.ws) socket.ws.close();
        socket.connected = false;
        return socket;
      }
    };

    function dispatch(event, data) {
      (listeners[event] || []).slice().forEach(function (handler) {
        try {
          handler(data);
        } catch (error) {
          setTimeout(function () { throw error; }, 0);
        }
      });
    }

    function clearReconnectTimer() {
      if (!reconnectTimer) return;
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    function scheduleReconnect() {
      if (!reconnectionEnabled || reconnectTimer) return;
      reconnectAttempts += 1;
      reconnectingAttempt = reconnectAttempts;
      var delay = Math.min(reconnectionDelayMax, reconnectionDelay * Math.pow(1.6, reconnectAttempts - 1));
      delay = Math.round(delay);
      dispatch('reconnecting', { attempt: reconnectAttempts, delay: delay });
      reconnectTimer = setTimeout(function () {
        reconnectTimer = null;
        socket.ws = null;
        socket.connect();
      }, delay);
    }

    socket.connect();
    return socket;
  }

  window.io = makeSocket;
})();
`;
