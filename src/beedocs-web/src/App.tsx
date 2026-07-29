import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { ThemeProvider } from './theme'
import { WorkspaceProvider } from './workspace/WorkspaceContext'
import { WorkspaceShell } from './components/WorkspaceShell'

export default function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <WorkspaceProvider>
          <Routes>
            <Route path="/" element={<WorkspaceShell />} />
            <Route path="/settings" element={<WorkspaceShell />} />
            <Route path="/books/:bookId" element={<WorkspaceShell />} />
            <Route path="/books/:bookId/pages/:pageId" element={<WorkspaceShell />} />
            <Route path="/books/:bookId/diagrams/:diagramId" element={<WorkspaceShell />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </WorkspaceProvider>
      </BrowserRouter>
    </ThemeProvider>
  )
}
