package ar.pariz.guarani

import android.app.Application

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Notifier.createChannels(this)
        Profiles.all(this).forEach { Store.ensureSeed(this, it.id) }
        Scheduler.schedule(this, replace = false)
    }
}
