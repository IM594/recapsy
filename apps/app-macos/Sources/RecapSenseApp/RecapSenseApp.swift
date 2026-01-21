import SwiftUI

@main
struct RecapSenseAppMain: App {
  @StateObject private var supervisor = Supervisor()

  var body: some Scene {
    MenuBarExtra("RecapSense", systemImage: "brain") {
      MenuBarView()
        .environmentObject(supervisor)
    }

    WindowGroup("RecapSense", id: "main") {
      MainWindowView()
        .environmentObject(supervisor)
    }
  }
}
