package com.blockingmachine.localvpn

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.security.KeyChain
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.security.cert.CertificateFactory

private const val VPN_CONSENT_REQUEST = 0xB10C

/**
 * JS bridge for the on-device filter services. The VPN path needs a one-time
 * system consent dialog. VpnDialogs' ConfirmDialog resolves the requesting
 * package via getCallingPackage(), which is only populated for
 * startActivityForResult — a plain startActivity self-finishes instantly.
 */
class LocalVpnModule : Module() {

  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("no react context")

  override fun definition() = ModuleDefinition {
    Name("LocalVpn")

    Events("onVpnConsentResult")

    OnActivityResult { _, payload ->
      if (payload.requestCode == VPN_CONSENT_REQUEST) {
        sendEvent(
          "onVpnConsentResult",
          mapOf("granted" to (payload.resultCode == Activity.RESULT_OK))
        )
      }
    }

    AsyncFunction("needsVpnConsent") {
      VpnService.prepare(context) != null
    }

    /** Launch the system VPN-consent dialog if consent isn't already held. */
    AsyncFunction("requestVpnConsent") {
      val intent = VpnService.prepare(context)
        ?: return@AsyncFunction true // already consented
      val activity: Activity? = appContext.activityProvider?.currentActivity
      if (activity != null) {
        activity.startActivityForResult(intent, VPN_CONSENT_REQUEST)
      } else {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        // A non-forResult launch can still show the consent dialog (a grant then
        // helps the next tap), but its result never comes back — tell JS now so
        // requestVpnConsent() doesn't wait on an event that cannot arrive.
        sendEvent("onVpnConsentResult", mapOf("granted" to false))
      }
      false
    }

    AsyncFunction("startVpn") { rulesPath: String, upstreamDns: String, label: String ->
      Intent(context, VpnFilterService::class.java).apply {
        action = VpnFilterService.ACTION_START
        putExtra(VpnFilterService.EXTRA_RULES_PATH, rulesPath)
        putExtra(VpnFilterService.EXTRA_UPSTREAM, upstreamDns)
        putExtra(VpnFilterService.EXTRA_LABEL, label)
      }.let {
        context.startForegroundService(it)
      }
      true
    }

    AsyncFunction("stopVpn") {
      context.startService(
        Intent(context, VpnFilterService::class.java).apply {
          action = VpnFilterService.ACTION_STOP
        }
      )
      true
    }

    AsyncFunction("startProxy") { rulesPath: String, port: Int ->
      Intent(context, PacProxyService::class.java).apply {
        action = PacProxyService.ACTION_START
        putExtra(PacProxyService.EXTRA_RULES_PATH, rulesPath)
        putExtra(PacProxyService.EXTRA_PORT, port)
      }.let {
        context.startForegroundService(it)
      }
      true
    }

    AsyncFunction("stopProxy") {
      context.startService(
        Intent(context, PacProxyService::class.java).apply {
          action = PacProxyService.ACTION_STOP
        }
      )
      true
    }

    /**
     * Arm hub HTTPS capture on the same tunnel: TCP :80/:443 is spliced to
     * `<hubHost>:9294` (PROXY-v2), other TCP is relayed, QUIC is suppressed.
     * Rides on ACTION_START — a running DNS filter keeps its ruleset.
     */
    AsyncFunction("startHttpsCapture") { hubHost: String ->
      Intent(context, VpnFilterService::class.java).apply {
        action = VpnFilterService.ACTION_START
        putExtra(VpnFilterService.EXTRA_HUB_HOST, hubHost)
      }.let {
        context.startForegroundService(it)
      }
      true
    }

    /** Capture off, tunnel up — flows fall through to the pass-through relay. */
    AsyncFunction("stopHttpsCapture") {
      context.startService(
        Intent(context, VpnFilterService::class.java).apply {
          action = VpnFilterService.ACTION_STOP_CAPTURE
        }
      )
      true
    }

    AsyncFunction("httpsCaptureStatus") {
      val stats = VpnFilterService.captureStats
      mapOf(
        "running" to VpnFilterService.captureRunning.get(),
        "flowsOpened" to (stats?.flowsOpened?.get() ?: 0L),
        "flowsClosed" to (stats?.flowsClosed?.get() ?: 0L),
        "quicDropped" to VpnFilterService.quicDropped.get(),
      )
    }

    /**
     * The legitimate user-CA install path: KeyChain's install intent drives
     * the system certificate-install UI — the user consents on Android's own
     * screen. The PEM is parsed to DER here (CertInstaller's expected form),
     * which also validates the fetched document before it reaches the UI.
     */
    AsyncFunction("installCaCertificate") { name: String, pem: String ->
      val der = CertificateFactory.getInstance("X.509")
        .generateCertificate(pem.byteInputStream()).encoded
      val intent = KeyChain.createInstallIntent().apply {
        putExtra(KeyChain.EXTRA_CERTIFICATE, der)
        putExtra(KeyChain.EXTRA_NAME, name)
      }
      val activity: Activity? = appContext.activityProvider?.currentActivity
      if (activity != null) {
        activity.startActivity(intent)
      } else {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
      }
      true
    }

    AsyncFunction("status") {
      mapOf(
        "vpnRunning" to VpnFilterService.running.get(),
        "dnsBlocked" to VpnFilterService.blockedCount.get(),
        "dnsForwarded" to VpnFilterService.forwardedCount.get(),
        "proxyRunning" to PacProxyService.running.get(),
        "proxyPort" to PacProxyService.boundPort,
        "proxyAllowed" to PacProxyService.allowedCount.get(),
        "proxyBlocked" to PacProxyService.blockedCount.get(),
      )
    }
  }
}
