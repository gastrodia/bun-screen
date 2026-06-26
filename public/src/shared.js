// 主播端与观众端共享的工具函数

export function generateClientId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID().slice(0, 8)
  }
  return Math.random().toString(36).slice(2, 10)
}

export function buildWsUrl() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${protocol}://${location.host}/api/ws`
}

// 返回一个向消息列表追加内容并自动滚动到底部的函数。
// 入参可以是字符串（自动包成 <li>）或已构造好的节点。
export function makeMessageAppender(container) {
  return (content) => {
    const li =
      typeof content === 'string'
        ? Object.assign(document.createElement('li'), {textContent: content})
        : content
    container.appendChild(li)
    container.scrollTop = container.scrollHeight
    return li
  }
}

export function sendSocketMessage(socket, type, data, onUnavailable) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    onUnavailable?.()
    return false
  }
  socket.send(JSON.stringify({type, data}))
  return true
}

export function dispatchSocketMessage(handlers, event) {
  let payload
  try {
    payload = JSON.parse(event.data)
  } catch {
    return
  }
  const handler = handlers[payload?.type]
  if (handler) handler(payload.data)
}

// 在 remoteDescription 就绪前缓存 candidate，避免 addIceCandidate 抛未捕获异常。
export function addIceCandidateSafe(peer, candidate) {
  if (!candidate) return
  if (peer.remoteDescription && peer.remoteDescription.type) {
    peer.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {})
  } else {
    ;(peer._pendingCandidates ||= []).push(candidate)
  }
}

export function flushIceCandidates(peer) {
  const pending = peer._pendingCandidates
  if (!pending) return
  peer._pendingCandidates = []
  for (const candidate of pending) {
    peer.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {})
  }
}
