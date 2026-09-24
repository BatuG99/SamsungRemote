package com.samsungremote

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.URI
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.UUID
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

class SamsungWebSocketModule(
  reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

  private val stateLock = Any()
  private val client = createSamsungTvClient()
  private val timeoutHandler = Handler(Looper.getMainLooper())
  private val preferences =
    reactContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

  private var socket: WebSocket? = null
  private var connectPromise: Promise? = null
  private var connectTimeout: Runnable? = null
  private var authorized = false
  private var connectionGeneration = 0L

  override fun getName(): String = NAME

  @ReactMethod
  fun connect(urlString: String, promise: Promise) {
    val clientName = getOrCreateClientName()
    val storedToken = preferences.getString(TOKEN_KEY, null)
    val request = try {
      val uri = URI(urlString)
      if ((uri.scheme != "ws" && uri.scheme != "wss") || uri.host == null) {
        throw IllegalArgumentException("Invalid WebSocket URL")
      }

      val originalRequest = Request.Builder().url(urlString).build()
      val urlBuilder = originalRequest.url
        .newBuilder()
        .removeAllQueryParameters("name")
        .removeAllQueryParameters("token")
        .addQueryParameter(
          "name",
          Base64.encodeToString(clientName.toByteArray(Charsets.UTF_8), Base64.NO_WRAP),
        )

      if (!storedToken.isNullOrBlank()) {
        urlBuilder.addQueryParameter("token", storedToken)
      }

      Request.Builder().url(urlBuilder.build()).build()
    } catch (error: Exception) {
      promise.reject("INVALID_URL", "Invalid WebSocket URL", error)
      return
    }

    val previousSocket = synchronized(stateLock) {
      val previous = socket
      cancelConnectTimeoutLocked()
      connectionGeneration += 1
      val generation = connectionGeneration

      connectPromise = promise
      authorized = false
      socket = client.newWebSocket(request, SamsungListener(generation))
      scheduleConnectTimeoutLocked(
        generation,
        if (storedToken.isNullOrBlank()) PAIRING_TIMEOUT_MS else CONNECT_TIMEOUT_MS,
      )
      previous
    }

    previousSocket?.cancel()
    Log.i(
      TAG,
      "Opening Samsung WebSocket with ${if (storedToken.isNullOrBlank()) "pairing" else "saved authorization"}",
    )
  }

  @ReactMethod
  fun send(message: String, promise: Promise) {
    val currentSocket = synchronized(stateLock) {
      if (authorized) socket else null
    }

    if (currentSocket == null) {
      promise.reject("NOT_CONNECTED", "Samsung WebSocket is not open")
      return
    }

    if (!currentSocket.send(message)) {
      promise.reject("SEND_FAILED", "Could not send WebSocket message")
      return
    }

    promise.resolve(true)
  }

  @ReactMethod
  fun wake(macAddress: String, broadcastAddress: String, promise: Promise) {
    Thread {
      try {
        val macBytes = parseMacAddress(macAddress)
        val magicPacket = createMagicPacket(macBytes)
        val destinations = setOf(broadcastAddress, LIMITED_BROADCAST_ADDRESS)

        DatagramSocket().use { datagramSocket ->
          datagramSocket.broadcast = true

          repeat(WAKE_PACKET_REPETITIONS) {
            destinations.forEach { destination ->
              datagramSocket.send(
                DatagramPacket(
                  magicPacket,
                  magicPacket.size,
                  InetAddress.getByName(destination),
                  WAKE_ON_LAN_PORT,
                ),
              )
            }
          }
        }

        Log.i(TAG, "Wake-on-LAN packet sent")
        promise.resolve(true)
      } catch (error: Exception) {
        promise.reject("WAKE_FAILED", "Could not wake Samsung TV", error)
      }
    }.start()
  }

  @ReactMethod
  fun close() {
    val currentSocket = synchronized(stateLock) {
      connectionGeneration += 1
      cancelConnectTimeoutLocked()
      val current = socket
      socket = null
      connectPromise = null
      authorized = false
      current
    }

    currentSocket?.close(NORMAL_CLOSURE, null)
  }

  override fun invalidate() {
    close()
    client.dispatcher.executorService.shutdown()
    client.connectionPool.evictAll()
    super.invalidate()
  }

  private fun getOrCreateClientName(): String {
    preferences.getString(CLIENT_NAME_KEY, null)
      ?.takeIf { it.isNotBlank() }
      ?.let { return it }

    val clientName =
      "SamsungRemote Android ${UUID.randomUUID().toString().take(8).uppercase()}"

    preferences.edit()
      .putString(CLIENT_NAME_KEY, clientName)
      .remove(TOKEN_KEY)
      .apply()

    Log.i(TAG, "Created unique Samsung TV client identity")
    return clientName
  }

  private fun scheduleConnectTimeoutLocked(generation: Long, timeoutMs: Long) {
    val timeoutTask = Runnable {
      val timedOutConnection = synchronized(stateLock) {
        if (
          generation != connectionGeneration ||
          authorized ||
          connectPromise == null
        ) {
          null
        } else {
          val timedOutSocket = socket
          val timedOutPromise = connectPromise

          socket = null
          connectPromise = null
          connectTimeout = null
          authorized = false

          timedOutSocket to timedOutPromise
        }
      }

      if (timedOutConnection != null) {
        timedOutConnection.first?.cancel()
        timedOutConnection.second?.reject(
          "CONNECTION_TIMEOUT",
          "Samsung TV did not authorize the WebSocket in time",
        )
        Log.i(TAG, "Samsung WebSocket authorization timed out")
      }
    }

    connectTimeout = timeoutTask
    timeoutHandler.postDelayed(timeoutTask, timeoutMs)
  }

  private fun cancelConnectTimeoutLocked() {
    connectTimeout?.let(timeoutHandler::removeCallbacks)
    connectTimeout = null
  }

  private inner class SamsungListener(
    private val generation: Long,
  ) : WebSocketListener() {

    override fun onOpen(webSocket: WebSocket, response: Response) {
      Log.i(TAG, "Native WebSocket transport opened")
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      val message = try {
        JSONObject(text)
      } catch (_: Exception) {
        return
      }
      val event = message.optString("event")
      Log.i(TAG, "Received Samsung TV event: $event")

      when (event) {
        "ms.channel.connect" -> {
          val promise = synchronized(stateLock) {
            if (!isCurrent(webSocket)) return
            cancelConnectTimeoutLocked()
            authorized = true
            connectPromise.also { connectPromise = null }
          }

          message.optJSONObject("data")
            ?.optString("token")
            ?.takeIf { it.isNotBlank() }
            ?.let { token ->
              preferences.edit().putString(TOKEN_KEY, token).apply()
              Log.i(TAG, "Saved Samsung TV authorization token")
            }

          promise?.resolve(true)
        }

        "ms.channel.unauthorized" -> {
          Log.i(TAG, "Samsung TV rejected this attempt; saved authorization retained")

          val promise = synchronized(stateLock) {
            if (!isCurrent(webSocket)) return
            cancelConnectTimeoutLocked()
            authorized = false
            connectPromise.also { connectPromise = null }
          }
          promise?.reject(
            "UNAUTHORIZED",
            "Samsung TV rejected the WebSocket connection",
          )
          webSocket.close(NORMAL_CLOSURE, null)
        }
      }
    }

    override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) {
      Log.i(TAG, "Samsung WebSocket failed: ${error.message}")

      val promise = synchronized(stateLock) {
        if (!isCurrent(webSocket)) return
        cancelConnectTimeoutLocked()
        socket = null
        authorized = false
        connectPromise.also { connectPromise = null }
      }
      promise?.reject(
        "CONNECTION_FAILED",
        error.message ?: "Samsung WebSocket connection failed",
        error,
      )
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
      Log.i(TAG, "Samsung WebSocket closed. Code: $code Reason: $reason")

      val promise = synchronized(stateLock) {
        if (!isCurrent(webSocket)) return
        cancelConnectTimeoutLocked()
        socket = null
        authorized = false
        connectPromise.also { connectPromise = null }
      }
      promise?.reject(
        "CONNECTION_CLOSED",
        "WebSocket closed before authorization. Code: $code",
      )
    }

    private fun isCurrent(webSocket: WebSocket): Boolean =
      generation == connectionGeneration && webSocket === socket
  }

  companion object {
    private const val NAME = "SamsungWebSocket"
    private const val TAG = "SamsungWebSocket"
    private const val PREFERENCES_NAME = "samsung_tv_authorization"
    private const val CLIENT_NAME_KEY = "remote_control_client_name"
    private const val TOKEN_KEY = "remote_control_token"
    private const val CONNECT_TIMEOUT_MS = 5_000L
    private const val PAIRING_TIMEOUT_MS = 30_000L
    private const val NORMAL_CLOSURE = 1000
    private const val LIMITED_BROADCAST_ADDRESS = "255.255.255.255"
    private const val WAKE_ON_LAN_PORT = 9
    private const val WAKE_PACKET_REPETITIONS = 3

    private fun parseMacAddress(macAddress: String): ByteArray {
      val parts = macAddress.split(':', '-')
      require(parts.size == 6 && parts.all { it.length == 2 }) {
        "Invalid MAC address"
      }
      return ByteArray(parts.size) { index -> parts[index].toInt(16).toByte() }
    }

    private fun createMagicPacket(macBytes: ByteArray): ByteArray =
      ByteArray(6 + 16 * macBytes.size).also { packet ->
        repeat(6) { packet[it] = 0xff.toByte() }
        repeat(16) { repetition ->
          macBytes.copyInto(
            destination = packet,
            destinationOffset = 6 + repetition * macBytes.size,
          )
        }
      }

    @Suppress("CustomX509TrustManager", "TrustAllX509TrustManager")
    private fun createSamsungTvClient(): OkHttpClient {
      val trustManager = object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = Unit
        override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) = Unit
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
      }
      val trustManagers = arrayOf<TrustManager>(trustManager)
      val sslContext = SSLContext.getInstance("TLS")
      sslContext.init(null, trustManagers, SecureRandom())

      // This client is used only for the Samsung TV's local WebSocket. Its
      // certificate is self-signed and usually does not match the IP address.
      return OkHttpClient.Builder()
        .sslSocketFactory(sslContext.socketFactory, trustManager)
        .hostnameVerifier { _, _ -> true }
        .build()
    }
  }
}
