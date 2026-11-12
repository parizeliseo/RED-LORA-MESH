package ar.pariz.guarani

import android.app.Application

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Notifier.createChannels(this)
        Store.ensureSeed(this)
        Scheduler.schedule(this, replace = false)
    }
}
