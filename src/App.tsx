import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

function App() {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* 拖动栏 - macOS 窗口拖动区域 */}
      <div className="h-8 w-full fixed top-0 left-0 z-50" style={{ WebkitAppRegion: 'drag' }}></div>

      {/* 内容区域 */}
      <div className="flex-1 flex items-center justify-center p-8">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>欢迎使用</CardTitle>
            <CardDescription>Electron + Vite + React + shadcn/ui</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">
              这是一个 Electron 桌面应用模板，你可以基于此开始开发。
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

export default App
