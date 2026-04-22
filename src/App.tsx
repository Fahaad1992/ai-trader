import { useState } from "react";
import { Toaster } from "sonner";
import Dashboard from "./pages/Dashboard";
import TradesPage from "./pages/Trades";
import HistoryPage from "./pages/History";
import ReportsPage from "./pages/Reports";
import SettingsPage from "./pages/Settings";
import LogsPage from "./pages/Logs";
import Sidebar from "./components/Sidebar";

const pages: Record<string, React.FC> = {
  dashboard: Dashboard,
  trades: TradesPage,
  history: HistoryPage,
  reports: ReportsPage,
  settings: SettingsPage,
  logs: LogsPage,
};

export default function App() {
  const [page, setPage] = useState("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const Page = pages[page] || Dashboard;

  return (
    <div dir="rtl" className="flex h-screen bg-background text-foreground overflow-hidden">
      <Sidebar page={page} setPage={setPage} open={sidebarOpen} setOpen={setSidebarOpen} />
      <main className="flex-1 overflow-y-auto p-4 md:p-6 transition-all order-first">
        <Page />
      </main>
      <Toaster theme="dark" position="top-left" dir="rtl" />
    </div>
  );
}
