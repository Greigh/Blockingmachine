package com.blockingmachine.localvpn

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.VpnService
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

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
