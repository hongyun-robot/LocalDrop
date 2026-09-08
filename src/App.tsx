import {
  AlertCircle,
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  Download,
  File as FileIcon,
  Files,
  Image as ImageIcon,
  Laptop,
  Moon,
  Pencil,
  Radio,
  Send,
  Smartphone,
  Sun,
  Type,
  UploadCloud,
  Wifi,
  X,
  Zap,
} from 'lucide-react'
import {
  ChangeEvent,
  DragEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

type ConnectionState = 'connecting' | 'online' | 'offline'
type DeviceType = 'desktop' | 'mobile'
type TransferStatus = 'connecting' | 'sending' | 'receiving' | 'complete' | 'error'
type Theme = 'dark' | 'light'

interface Device {
  id: string
  name: string
  deviceType: DeviceType
  webRtc: boolean
}

interface TransferItem {
  id: string
  kind: 'text' | 'file'
  name: string
  size: number
  type: string
  text?: string
  blobUrl?: string
}

interface TransferRecord {
  id: string
  direction: 'outgoing' | 'incoming'
  peerName: string
  items: TransferItem[]
  totalBytes: number
  transferredBytes: number
  speed: number
  status: TransferStatus
  createdAt: number
  error?: string
}

interface BatchMessage {
  kind: 'batch'
  transferId: string
  items: TransferItem[]
  totalBytes: number
}

interface IncomingSession {
  transferId?: string
  totalBytes: number
  receivedBytes: number
  startedAt: number
  currentFileId?: string
  chunks: Map<string, ArrayBuffer[]>
  lastProgressAt: number
}

interface PeerSession {
  pc?: RTCPeerConnection
  remoteId: string
  channel?: RTCDataChannel
  incoming?: IncomingSession
  pendingCandidates: RTCIceCandidateInit[]
  transport: 'webrtc' | 'relay'
}

// 16 KB stays below Safari's conservative SCTP message limit.
const CHUNK_SIZE = 16 * 1024
const MAX_BUFFERED = 4 * 1024 * 1024

function makeId() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function supportsWebRtc() {
  try {
    if (typeof globalThis.RTCPeerConnection !== 'function') return false
    const connection = new globalThis.RTCPeerConnection({ iceServers: [] })
    connection.close()
    return true
  } catch {
    return false
  }
}

function bufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index])
  return btoa(binary)
}

function base64ToBuffer(encoded: string) {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes.buffer
}

function detectDeviceType(): DeviceType {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ? 'mobile' : 'desktop'
}

function defaultDeviceName() {
  const type = detectDeviceType()
  if (type === 'mobile') return /iPhone|iPad|iPod/i.test(navigator.userAgent) ? '我的 iPhone' : '我的手机'
  if (/Macintosh|Mac OS/i.test(navigator.userAgent)) return '我的 Mac'
  return '我的电脑'
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** index
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
}

function formatSpeed(bytesPerSecond: number) {
  return bytesPerSecond > 0 ? `${formatBytes(bytesPerSecond)}/s` : '—'
}

function fileTypeLabel(type: string, name: string) {
  if (type.startsWith('image/')) return '图片'
  if (type.startsWith('video/')) return '视频'
  if (type.startsWith('audio/')) return '音频'
  if (type === 'application/pdf') return 'PDF'
  const extension = name.includes('.') ? name.split('.').pop()?.toUpperCase() : ''
  return extension || type || '文件'
}

function jsonSend(channel: RTCDataChannel, payload: unknown) {
  channel.send(JSON.stringify(payload))
}

function App() {
  const [webRtcSupported] = useState(supportsWebRtc)
  const [theme, setTheme] = useState<Theme>(() => {
    const preset = document.documentElement.dataset.theme
    if (preset === 'light' || preset === 'dark') return preset
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  })
  const [deviceName, setDeviceName] = useState(() => localStorage.getItem('localdrop-device-name') || defaultDeviceName())
  const [draftName, setDraftName] = useState(deviceName)
  const [editingName, setEditingName] = useState(false)
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting')
  const [myId, setMyId] = useState('')
  const [devices, setDevices] = useState<Device[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('')
  const [mode, setMode] = useState<'text' | 'files'>('text')
  const [textValue, setTextValue] = useState('')
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [dragging, setDragging] = useState(false)
  const [transfers, setTransfers] = useState<TransferRecord[]>([])
  const [toast, setToast] = useState('')

  const socketRef = useRef<WebSocket | null>(null)
  const myIdRef = useRef('')
  const nameRef = useRef(deviceName)
  const devicesRef = useRef<Device[]>([])
  const sessionsRef = useRef(new Map<string, PeerSession>())
  const transfersRef = useRef<TransferRecord[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const reconnectTimerRef = useRef<number | null>(null)

  const peerDevices = useMemo(() => devices.filter((device) => device.id !== myId), [devices, myId])
  const selectedDevice = peerDevices.find((device) => device.id === selectedDeviceId)

  useEffect(() => {
    devicesRef.current = devices
  }, [devices])

  useEffect(() => {
    transfersRef.current = transfers
  }, [transfers])

  useEffect(() => {
    nameRef.current = deviceName
  }, [deviceName])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('localdrop-theme', theme)
    const themeMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    if (themeMeta) themeMeta.content = theme === 'light' ? '#f2f7fb' : '#0c1220'
  }, [theme])

  const showToast = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(''), 2200)
  }, [])

  const updateTransfer = useCallback((id: string, updates: Partial<TransferRecord>) => {
    setTransfers((current) => current.map((transfer) => (transfer.id === id ? { ...transfer, ...updates } : transfer)))
  }, [])

  const sendSignal = useCallback((targetId: string, sessionId: string, signal: unknown) => {
    const socket = socketRef.current
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'signal', targetId, sessionId, signal }))
    }
  }, [])

  const sendRelay = useCallback((targetId: string, sessionId: string, dataType: 'text' | 'binary', data: string) => {
    const socket = socketRef.current
    if (socket?.readyState !== WebSocket.OPEN) throw new Error('局域网连接已断开')
    socket.send(JSON.stringify({ type: 'relay', targetId, sessionId, payload: { dataType, data } }))
  }, [])

  const closeSession = useCallback((sessionId: string) => {
    const session = sessionsRef.current.get(sessionId)
    if (!session) return
    session.channel?.close()
    session.pc?.close()
    sessionsRef.current.delete(sessionId)
  }, [])

  const receiveChannelMessage = useCallback(
    async (sessionId: string, event: MessageEvent<string | ArrayBuffer | Blob>) => {
      const session = sessionsRef.current.get(sessionId)
      if (!session) return

      if (typeof event.data !== 'string') {
        const incoming = session.incoming
        if (!incoming?.transferId || !incoming.currentFileId) return
        const chunk = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data
        const chunks = incoming.chunks.get(incoming.currentFileId) || []
        chunks.push(chunk)
        incoming.chunks.set(incoming.currentFileId, chunks)
        incoming.receivedBytes += chunk.byteLength

        const now = performance.now()
        if (now - incoming.lastProgressAt > 90 || incoming.receivedBytes >= incoming.totalBytes) {
          incoming.lastProgressAt = now
          const elapsed = Math.max((now - incoming.startedAt) / 1000, 0.1)
          updateTransfer(incoming.transferId, {
            transferredBytes: incoming.receivedBytes,
            speed: incoming.receivedBytes / elapsed,
          })
        }
        return
      }

      let message: Record<string, unknown>
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }

      if (message.kind === 'batch') {
        const batch = message as unknown as BatchMessage
        const peer = devicesRef.current.find((device) => device.id === session.remoteId)
        session.incoming = {
          transferId: batch.transferId,
          totalBytes: batch.totalBytes,
          receivedBytes: 0,
          startedAt: performance.now(),
          chunks: new Map(),
          lastProgressAt: 0,
        }
        setTransfers((current) => [
          {
            id: batch.transferId,
            direction: 'incoming',
            peerName: peer?.name || '局域网设备',
            items: batch.items,
            totalBytes: batch.totalBytes,
            transferredBytes: 0,
            speed: 0,
            status: 'receiving',
            createdAt: Date.now(),
          },
          ...current,
        ])
        return
      }

      const incoming = session.incoming
      if (!incoming?.transferId) return

      if (message.kind === 'text' && typeof message.text === 'string') {
        const itemId = String(message.itemId)
        const size = new Blob([message.text]).size
        incoming.receivedBytes += size
        setTransfers((current) =>
          current.map((transfer) =>
            transfer.id === incoming.transferId
              ? {
                  ...transfer,
                  items: transfer.items.map((item) => (item.id === itemId ? { ...item, text: message.text as string } : item)),
                  transferredBytes: incoming.receivedBytes,
                }
              : transfer,
          ),
        )
      }

      if (message.kind === 'file-start') {
        incoming.currentFileId = String(message.itemId)
        incoming.chunks.set(incoming.currentFileId, [])
      }

      if (message.kind === 'file-end') {
        const itemId = String(message.itemId)
        const chunks = incoming.chunks.get(itemId) || []
        const transfer = transfersRef.current.find((record) => record.id === incoming.transferId)
        const item = transfer?.items.find((entry) => entry.id === itemId)
        const blobUrl = URL.createObjectURL(new Blob(chunks, { type: item?.type || 'application/octet-stream' }))
        setTransfers((current) =>
          current.map((record) =>
            record.id === incoming.transferId
              ? {
                  ...record,
                  items: record.items.map((entry) => (entry.id === itemId ? { ...entry, blobUrl } : entry)),
                }
              : record,
          ),
        )
        incoming.chunks.delete(itemId)
        incoming.currentFileId = undefined
      }

      if (message.kind === 'complete') {
        const elapsed = Math.max((performance.now() - incoming.startedAt) / 1000, 0.1)
        updateTransfer(incoming.transferId, {
          transferredBytes: incoming.totalBytes,
          speed: incoming.totalBytes / elapsed,
          status: 'complete',
        })
        showToast('收到新的内容')
        window.setTimeout(() => closeSession(sessionId), 600)
      }
    },
    [closeSession, showToast, updateTransfer],
  )

  const attachIncomingChannel = useCallback(
    (sessionId: string, channel: RTCDataChannel) => {
      const session = sessionsRef.current.get(sessionId)
      if (!session) return
      session.channel = channel
      channel.binaryType = 'arraybuffer'
      channel.onmessage = (event) => void receiveChannelMessage(sessionId, event)
    },
    [receiveChannelMessage],
  )

  const createPeer = useCallback(
    (remoteId: string, sessionId: string) => {
      if (typeof globalThis.RTCPeerConnection !== 'function') throw new Error('当前浏览器不支持 WebRTC')
      const pc = new globalThis.RTCPeerConnection({ iceServers: [] })
      const session: PeerSession = { pc, remoteId, pendingCandidates: [], transport: 'webrtc' }
      sessionsRef.current.set(sessionId, session)

      pc.onicecandidate = (event) => {
        if (event.candidate) sendSignal(remoteId, sessionId, { kind: 'ice', candidate: event.candidate.toJSON() })
      }
      pc.ondatachannel = (event) => attachIncomingChannel(sessionId, event.channel)
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') {
          if (session.incoming?.transferId) {
            updateTransfer(session.incoming.transferId, { status: 'error', error: '设备连接失败' })
          }
          closeSession(sessionId)
        }
      }
      return session
    },
    [attachIncomingChannel, closeSession, sendSignal, updateTransfer],
  )

  const handleSignal = useCallback(
    async (fromId: string, sessionId: string, signal: Record<string, unknown>) => {
      let session = sessionsRef.current.get(sessionId)

      if (signal.kind === 'offer') {
        if (!webRtcSupported) return
        if (!session) session = createPeer(fromId, sessionId)
        const pc = session.pc
        if (!pc) return
        await pc.setRemoteDescription(signal.description as RTCSessionDescriptionInit)
        for (const candidate of session.pendingCandidates) await pc.addIceCandidate(candidate)
        session.pendingCandidates = []
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        sendSignal(fromId, sessionId, { kind: 'answer', description: pc.localDescription })
        return
      }

      if (!session) return
      const pc = session.pc
      if (!pc) return

      if (signal.kind === 'answer') {
        await pc.setRemoteDescription(signal.description as RTCSessionDescriptionInit)
        for (const candidate of session.pendingCandidates) await pc.addIceCandidate(candidate)
        session.pendingCandidates = []
      }

      if (signal.kind === 'ice') {
        const candidate = signal.candidate as RTCIceCandidateInit
        if (pc.remoteDescription) await pc.addIceCandidate(candidate)
        else session.pendingCandidates.push(candidate)
      }
    },
    [createPeer, sendSignal, webRtcSupported],
  )

  useEffect(() => {
    let disposed = false

    const connect = () => {
      if (disposed) return
      setConnectionState('connecting')
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
      const socket = new WebSocket(`${protocol}://${location.host}/ws`)
      socketRef.current = socket

      socket.onopen = () => {
        setConnectionState('online')
        socket.send(JSON.stringify({
          type: 'hello',
          name: nameRef.current,
          deviceType: detectDeviceType(),
          webRtc: webRtcSupported,
        }))
      }
      socket.onmessage = (event) => {
        let message: Record<string, unknown>
        try {
          message = JSON.parse(event.data)
        } catch {
          return
        }
        if (message.type === 'welcome') {
          const id = String(message.id)
          myIdRef.current = id
          setMyId(id)
        }
        if (message.type === 'devices') {
          const nextDevices = message.devices as Device[]
          devicesRef.current = nextDevices
          setDevices(nextDevices)
        }
        if (message.type === 'signal') {
          void handleSignal(String(message.fromId), String(message.sessionId), message.signal as Record<string, unknown>)
        }
        if (message.type === 'relay') {
          const sessionId = String(message.sessionId)
          const remoteId = String(message.fromId)
          if (!sessionsRef.current.has(sessionId)) {
            sessionsRef.current.set(sessionId, {
              remoteId,
              pendingCandidates: [],
              transport: 'relay',
            })
          }
          const payload = message.payload as { dataType: 'text' | 'binary'; data: string }
          const data = payload.dataType === 'binary' ? base64ToBuffer(payload.data) : payload.data
          void receiveChannelMessage(sessionId, { data } as MessageEvent<string | ArrayBuffer>)
        }
      }
      socket.onclose = () => {
        if (disposed) return
        setConnectionState('offline')
        setDevices([])
        reconnectTimerRef.current = window.setTimeout(connect, 1800)
      }
      socket.onerror = () => socket.close()
    }

    connect()
    return () => {
      disposed = true
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current)
      socketRef.current?.close()
      for (const sessionId of sessionsRef.current.keys()) closeSession(sessionId)
    }
  }, [closeSession, handleSignal, receiveChannelMessage, webRtcSupported])

  useEffect(() => {
    if (selectedDeviceId && !peerDevices.some((device) => device.id === selectedDeviceId)) setSelectedDeviceId('')
  }, [peerDevices, selectedDeviceId])

  useEffect(() => {
    return () => {
      for (const transfer of transfersRef.current) {
        for (const item of transfer.items) if (item.blobUrl) URL.revokeObjectURL(item.blobUrl)
      }
    }
  }, [])

  const saveName = () => {
    const cleanName = draftName.trim().slice(0, 32)
    if (!cleanName) return
    setDeviceName(cleanName)
    nameRef.current = cleanName
    localStorage.setItem('localdrop-device-name', cleanName)
    setEditingName(false)
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'rename', name: cleanName }))
    }
  }

  const onNameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') saveName()
    if (event.key === 'Escape') {
      setDraftName(deviceName)
      setEditingName(false)
    }
  }

  const addFiles = (files: FileList | File[]) => {
    const next = Array.from(files)
    setSelectedFiles((current) => {
      const known = new Set(current.map((file) => `${file.name}-${file.size}-${file.lastModified}`))
      return [...current, ...next.filter((file) => !known.has(`${file.name}-${file.size}-${file.lastModified}`))]
    })
  }

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) addFiles(event.target.files)
    event.target.value = ''
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    addFiles(event.dataTransfer.files)
  }

  const waitForOpen = (channel: RTCDataChannel) =>
    new Promise<void>((resolve, reject) => {
      if (channel.readyState === 'open') return resolve()
      const timeout = window.setTimeout(() => reject(new Error('连接超时')), 15_000)
      channel.addEventListener(
        'open',
        () => {
          window.clearTimeout(timeout)
          resolve()
        },
        { once: true },
      )
      channel.addEventListener(
        'error',
        () => {
          window.clearTimeout(timeout)
          reject(new Error('连接失败'))
        },
        { once: true },
      )
    })

  const waitForBuffer = (channel: RTCDataChannel) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (channel.bufferedAmount <= MAX_BUFFERED || channel.readyState !== 'open') resolve()
        else window.setTimeout(check, 12)
      }
      check()
    })

  const waitForDrain = (channel: RTCDataChannel) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (channel.bufferedAmount === 0 || channel.readyState !== 'open') resolve()
        else window.setTimeout(check, 20)
      }
      check()
    })

  const waitForSocketBuffer = (drain = false) =>
    new Promise<void>((resolve) => {
      const check = () => {
        const socket = socketRef.current
        if (!socket || socket.readyState !== WebSocket.OPEN || (drain ? socket.bufferedAmount === 0 : socket.bufferedAmount <= MAX_BUFFERED)) {
          resolve()
        } else {
          window.setTimeout(check, drain ? 20 : 12)
        }
      }
      check()
    })

  const startTransfer = async () => {
    if (!selectedDevice) return showToast('请先选择接收设备')
    if (mode === 'text' && !textValue.trim()) return showToast('请输入要发送的文本')
    if (mode === 'files' && selectedFiles.length === 0) return showToast('请先选择文件')

    const transferId = makeId()
    const sessionId = makeId()
    const outgoingText = textValue
    const outgoingFiles = [...selectedFiles]
    const items: TransferItem[] =
      mode === 'text'
        ? [
            {
              id: makeId(),
              kind: 'text',
              name: '文本消息',
              size: new Blob([outgoingText]).size,
              type: 'text/plain',
              text: outgoingText,
            },
          ]
        : outgoingFiles.map((file) => ({
            id: makeId(),
            kind: 'file',
            name: file.name,
            size: file.size,
            type: file.type || 'application/octet-stream',
          }))
    const totalBytes = items.reduce((sum, item) => sum + item.size, 0)

    setTransfers((current) => [
      {
        id: transferId,
        direction: 'outgoing',
        peerName: selectedDevice.name,
        items,
        totalBytes,
        transferredBytes: 0,
        speed: 0,
        status: 'connecting',
        createdAt: Date.now(),
      },
      ...current,
    ])

    try {
      let sendJson: (payload: unknown) => void
      let sendBinary: (chunk: ArrayBuffer) => void
      let waitForCapacity: () => Promise<void>
      let waitUntilDrained: () => Promise<void>

      if (webRtcSupported && selectedDevice.webRtc) {
        const session = createPeer(selectedDevice.id, sessionId)
        const pc = session.pc
        if (!pc) throw new Error('无法创建点对点连接')
        const channel = pc.createDataChannel('localdrop', { ordered: true })
        session.channel = channel
        channel.binaryType = 'arraybuffer'
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        sendSignal(selectedDevice.id, sessionId, { kind: 'offer', description: pc.localDescription })
        await waitForOpen(channel)
        sendJson = (payload) => jsonSend(channel, payload)
        sendBinary = (chunk) => channel.send(chunk)
        waitForCapacity = () => waitForBuffer(channel)
        waitUntilDrained = () => waitForDrain(channel)
      } else {
        sessionsRef.current.set(sessionId, {
          remoteId: selectedDevice.id,
          pendingCandidates: [],
          transport: 'relay',
        })
        sendJson = (payload) => sendRelay(selectedDevice.id, sessionId, 'text', JSON.stringify(payload))
        sendBinary = (chunk) => sendRelay(selectedDevice.id, sessionId, 'binary', bufferToBase64(chunk))
        waitForCapacity = () => waitForSocketBuffer(false)
        waitUntilDrained = () => waitForSocketBuffer(true)
      }

      updateTransfer(transferId, { status: 'sending' })

      sendJson({
        kind: 'batch',
        transferId,
        totalBytes,
        items: items.map(({ id, kind, name, size, type }) => ({ id, kind, name, size, type })),
      })

      const startedAt = performance.now()
      let sentBytes = 0
      let lastUpdate = 0

      if (mode === 'text') {
        sendJson({ kind: 'text', itemId: items[0].id, text: outgoingText })
        sentBytes = items[0].size
      } else {
        for (let fileIndex = 0; fileIndex < outgoingFiles.length; fileIndex += 1) {
          const file = outgoingFiles[fileIndex]
          const item = items[fileIndex]
          sendJson({ kind: 'file-start', itemId: item.id })
          for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
            await waitForCapacity()
            const chunk = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer()
            sendBinary(chunk)
            sentBytes += chunk.byteLength
            const now = performance.now()
            if (now - lastUpdate > 90 || sentBytes >= totalBytes) {
              const elapsed = Math.max((now - startedAt) / 1000, 0.1)
              updateTransfer(transferId, { transferredBytes: sentBytes, speed: sentBytes / elapsed })
              lastUpdate = now
            }
          }
          sendJson({ kind: 'file-end', itemId: item.id })
        }
      }

      sendJson({ kind: 'complete' })
      await waitUntilDrained()
      const elapsed = Math.max((performance.now() - startedAt) / 1000, 0.1)
      updateTransfer(transferId, {
        status: 'complete',
        transferredBytes: totalBytes,
        speed: totalBytes / elapsed,
      })
      if (mode === 'text') setTextValue('')
      else setSelectedFiles([])
      showToast('发送完成')
      window.setTimeout(() => closeSession(sessionId), 700)
    } catch (error) {
      updateTransfer(transferId, {
        status: 'error',
        error: error instanceof Error ? error.message : '发送失败',
      })
      closeSession(sessionId)
    }
  }

  const copyText = async (text: string) => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text)
      else {
        const textarea = document.createElement('textarea')
        textarea.value = text
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        textarea.remove()
      }
      showToast('已复制到剪贴板')
    } catch {
      showToast('复制失败，请手动选择文本')
    }
  }

  const canSend = Boolean(selectedDevice) && (mode === 'text' ? Boolean(textValue.trim()) : selectedFiles.length > 0)

  return (
    <div className="app-shell">
      <div className="orb orb-one" />
      <div className="orb orb-two" />

      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div>
            <div className="brand-name">LocalDrop</div>
            <div className="brand-caption">局域网快传</div>
          </div>
        </div>

        <div className="header-actions">
          <div className={`connection-chip ${connectionState}`}>
            <span className="status-dot" />
            {connectionState === 'online' ? '已连接局域网' : connectionState === 'connecting' ? '正在连接' : '连接已断开'}
          </div>
          <button
            className="theme-toggle"
            onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
            aria-label={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
            title={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <div className="device-name-control">
            {editingName ? (
              <>
                <input
                  autoFocus
                  value={draftName}
                  maxLength={32}
                  onChange={(event) => setDraftName(event.target.value)}
                  onKeyDown={onNameKeyDown}
                  aria-label="设备名称"
                />
                <button className="icon-button confirm" onClick={saveName} aria-label="保存设备名称">
                  <Check size={17} />
                </button>
              </>
            ) : (
              <>
                <div className="self-device-icon">{detectDeviceType() === 'mobile' ? <Smartphone /> : <Laptop />}</div>
                <div className="self-device-text">
                  <span>本机名称</span>
                  <strong>{deviceName}</strong>
                </div>
                <button
                  className="icon-button"
                  onClick={() => {
                    setDraftName(deviceName)
                    setEditingName(true)
                  }}
                  aria-label="修改设备名称"
                >
                  <Pencil size={16} />
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      <main>
        <div className="workspace-grid">
          <section className="panel devices-panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow"><Radio size={14} /> 自动发现</span>
                <h1>选择接收设备</h1>
              </div>
              <span className="count-badge">{peerDevices.length} 台在线</span>
            </div>

            <div className="device-list">
              {peerDevices.length === 0 ? (
                <div className="empty-devices">
                  <div className="radar" aria-hidden="true">
                    <span className="radar-ring ring-one" />
                    <span className="radar-ring ring-two" />
                    <Wifi size={24} />
                  </div>
                  <strong>正在寻找附近设备</strong>
                  <p>让另一台设备打开当前网址，并连接到同一个局域网。</p>
                </div>
              ) : (
                peerDevices.map((device) => {
                  const selected = device.id === selectedDeviceId
                  return (
                    <button
                      key={device.id}
                      className={`device-card ${selected ? 'selected' : ''}`}
                      onClick={() => setSelectedDeviceId(device.id)}
                      aria-pressed={selected}
                    >
                      <span className="device-icon">
                        {device.deviceType === 'mobile' ? <Smartphone size={24} /> : <Laptop size={25} />}
                      </span>
                      <span className="device-info">
                        <strong>{device.name}</strong>
                        <span><i /> 在线 · {device.deviceType === 'mobile' ? '移动设备' : '电脑'}</span>
                      </span>
                      <span className="select-indicator">{selected ? <Check size={17} /> : <ChevronRight size={18} />}</span>
                    </button>
                  )
                })
              )}
            </div>

            <div className="privacy-note">
              <Zap size={17} />
              <div>
                <strong>局域网内即时传输</strong>
                <span>内容不会在服务端落盘保存</span>
              </div>
            </div>
          </section>

          <section className="panel send-panel">
            <div className="panel-heading send-heading">
              <div>
                <span className="eyebrow"><Send size={14} /> 发送内容</span>
                <h2>{selectedDevice ? `发送到 ${selectedDevice.name}` : '先在左侧选择设备'}</h2>
              </div>
            </div>

            <div className="mode-switch" role="tablist" aria-label="发送内容类型">
              <button className={mode === 'text' ? 'active' : ''} onClick={() => setMode('text')} role="tab" aria-selected={mode === 'text'}>
                <Type size={17} /> 文本
              </button>
              <button className={mode === 'files' ? 'active' : ''} onClick={() => setMode('files')} role="tab" aria-selected={mode === 'files'}>
                <Files size={17} /> 文件 / 图片
              </button>
            </div>

            {mode === 'text' ? (
              <div className="text-composer">
                <textarea
                  value={textValue}
                  onChange={(event) => setTextValue(event.target.value)}
                  placeholder="输入或粘贴要发送的文本…"
                  aria-label="要发送的文本"
                />
                <span className="char-count">{textValue.length.toLocaleString()} 字符</span>
              </div>
            ) : (
              <div className="files-composer">
                <div
                  className={`drop-zone ${dragging ? 'dragging' : ''}`}
                  onDragEnter={(event) => {
                    event.preventDefault()
                    setDragging(true)
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDragLeave={(event) => {
                    if (event.currentTarget === event.target) setDragging(false)
                  }}
                  onDrop={onDrop}
                  onClick={() => fileInputRef.current?.click()}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') fileInputRef.current?.click()
                  }}
                >
                  <input ref={fileInputRef} type="file" multiple onChange={onFileChange} hidden />
                  <div className="upload-icon"><UploadCloud size={24} /></div>
                  <strong>{dragging ? '松手添加文件' : '拖放文件到这里'}</strong>
                  <span>或点击选择多个文件</span>
                </div>

                {selectedFiles.length > 0 && (
                  <div className="selected-files">
                    <div className="file-list-summary">
                      <span>已选择 {selectedFiles.length} 个文件</span>
                      <span>{formatBytes(selectedFiles.reduce((sum, file) => sum + file.size, 0))}</span>
                    </div>
                    {selectedFiles.map((file, index) => (
                      <div className="file-row" key={`${file.name}-${file.lastModified}-${index}`}>
                        <span className="file-icon">{file.type.startsWith('image/') ? <ImageIcon size={19} /> : <FileIcon size={19} />}</span>
                        <span className="file-details">
                          <strong title={file.name}>{file.name}</strong>
                          <span>{fileTypeLabel(file.type, file.name)} · {formatBytes(file.size)}</span>
                        </span>
                        <button
                          className="icon-button"
                          onClick={() => setSelectedFiles((current) => current.filter((_, currentIndex) => currentIndex !== index))}
                          aria-label={`移除 ${file.name}`}
                        >
                          <X size={16} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <button className="send-button" disabled={!canSend} onClick={() => void startTransfer()}>
              <Send size={19} />
              {selectedDevice ? `发送到 ${selectedDevice.name}` : '请选择接收设备'}
            </button>
          </section>
        </div>

        <section className="panel activity-panel">
          <div className="panel-heading activity-heading">
            <div>
              <span className="eyebrow"><Zap size={14} /> 传输动态</span>
              <h2>最近传输</h2>
            </div>
            {transfers.length > 0 && <span className="count-badge">{transfers.length} 条</span>}
          </div>

          {transfers.length === 0 ? (
            <div className="empty-activity">
              <span className="empty-activity-icon"><ArrowUpRight size={21} /></span>
              <div>
                <strong>还没有传输记录</strong>
                <span>发送或收到的内容会显示在这里</span>
              </div>
            </div>
          ) : (
            <div className="transfer-list">
              {transfers.map((transfer) => (
                <TransferCard key={transfer.id} transfer={transfer} onCopy={copyText} />
              ))}
            </div>
          )}
        </section>
      </main>

      <footer>
        <span>LocalDrop</span>
        <span className="footer-separator" />
        <span>同一局域网内，无需登录</span>
      </footer>

      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={18} /> {toast}
        </div>
      )}
    </div>
  )
}

function TransferCard({ transfer, onCopy }: { transfer: TransferRecord; onCopy: (text: string) => void }) {
  const progress = transfer.totalBytes === 0 ? 100 : Math.min(100, Math.round((transfer.transferredBytes / transfer.totalBytes) * 100))
  const active = transfer.status === 'sending' || transfer.status === 'receiving' || transfer.status === 'connecting'
  const statusLabel =
    transfer.status === 'connecting'
      ? '正在连接…'
      : transfer.status === 'sending'
        ? '正在发送'
        : transfer.status === 'receiving'
          ? '正在接收'
          : transfer.status === 'complete'
            ? '传输完成'
            : transfer.error || '传输失败'

  return (
    <article className={`transfer-card ${transfer.status}`}>
      <div className="transfer-topline">
        <span className={`direction-icon ${transfer.direction}`}>
          {transfer.direction === 'outgoing' ? <ArrowUpRight size={19} /> : <ArrowDownLeft size={19} />}
        </span>
        <div className="transfer-title">
          <strong>{transfer.direction === 'outgoing' ? `发送给 ${transfer.peerName}` : `来自 ${transfer.peerName}`}</strong>
          <span>{new Date(transfer.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
        <span className="transfer-status">
          {transfer.status === 'complete' && <CheckCircle2 size={16} />}
          {transfer.status === 'error' && <AlertCircle size={16} />}
          {statusLabel}
        </span>
      </div>

      <div className="transfer-items">
        {transfer.items.map((item) =>
          item.kind === 'text' ? (
            <div className="received-text" key={item.id}>
              <p>{item.text ?? (transfer.status === 'complete' ? '' : '正在接收文本…')}</p>
              {item.text !== undefined && (
                <button onClick={() => onCopy(item.text || '')}>
                  <Copy size={15} /> 一键复制
                </button>
              )}
            </div>
          ) : (
            <div className="transfer-file" key={item.id}>
              <span className="file-icon">{item.type.startsWith('image/') ? <ImageIcon size={18} /> : <FileIcon size={18} />}</span>
              <span className="file-details">
                <strong title={item.name}>{item.name}</strong>
                <span>{fileTypeLabel(item.type, item.name)} · {formatBytes(item.size)}</span>
              </span>
              {transfer.direction === 'incoming' && item.blobUrl && (
                <a href={item.blobUrl} download={item.name} className="download-button" aria-label={`下载 ${item.name}`}>
                  <Download size={17} />
                </a>
              )}
            </div>
          ),
        )}
      </div>

      {(active || transfer.status === 'complete') && (
        <div className="progress-area">
          <div className="progress-meta">
            <span>{active ? `${formatBytes(transfer.transferredBytes)} / ${formatBytes(transfer.totalBytes)}` : formatBytes(transfer.totalBytes)}</span>
            <span>{formatSpeed(transfer.speed)} <b>{progress}%</b></span>
          </div>
          <div className="progress-track" aria-label={`传输进度 ${progress}%`} role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}
    </article>
  )
}

export default App
