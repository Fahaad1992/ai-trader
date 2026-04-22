import { LayoutDashboard, Activity, History, BarChart3, Settings, Bot, PanelLeft, PanelRight } from "lucide-react";

const items = [
  { id: "dashboard", label: "لوحة التحكم", icon: LayoutDashboard },
  { id: "trades", label: "الصفقات المفتوحة", icon: Activity },
  { id: "history", label: "سجل الصفقات", icon: History },
  { id: "reports", label: "التقارير", icon: BarChart3 },
  { id: "settings", label: "الإعدادات", icon: Settings },
  { id: "logs", label: "سجل البوت", icon: Bot },
];

interface Props {
  page: string;
  setPage: (p: string) => void;
  open: boolean;
  setOpen: (o: boolean) => void;
}

export default function Sidebar({ page, setPage, open, setOpen }: Props) {
  return (
    <>
      {/* Mobile overlay */}
      {open && (
        <div className="fixed inset-0 bg-black/50 z-40 md:hidden" onClick={() => setOpen(false)} />
      )}

      {/* Toggle button for mobile */}
      <button
        className="fixed top-3 right-3 z-50 md:hidden p-2 rounded-lg bg-card border border-border"
        onClick={() => setOpen(!open)}
      >
        {open ? <PanelRight className="h-5 w-5" /> : <PanelLeft className="h-5 w-5" />}
      </button>

      {/* Sidebar - right side for RTL */}
      <aside className={`
        fixed md:relative z-40 h-full bg-card border-l border-border transition-all duration-300 right-0
        ${open ? "w-56 translate-x-0" : "w-0 translate-x-full md:w-16 md:translate-x-0"}
      `}>
        <div className="flex flex-col h-full overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b border-border">
            {open && (
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center">
                  <Bot className="h-4 w-4 text-primary" />
                </div>
                <span className="font-bold text-sm text-primary">بوت التداول</span>
              </div>
            )}
            <button
              className="hidden md:block p-1.5 rounded-md hover:bg-secondary transition-colors"
              onClick={() => setOpen(!open)}
            >
              {open ? <PanelRight className="h-4 w-4 text-muted-foreground" /> : <PanelLeft className="h-4 w-4 text-muted-foreground" />}
            </button>
          </div>

          {/* Nav items */}
          <nav className="flex-1 p-2 space-y-1">
            {items.map(item => {
              const Icon = item.icon;
              const active = page === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => { setPage(item.id); if (window.innerWidth < 768) setOpen(false); }}
                  className={`
                    w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors
                    ${active ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:bg-secondary hover:text-foreground"}
                  `}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {open && <span className="truncate">{item.label}</span>}
                </button>
              );
            })}
          </nav>

          {/* Footer */}
          {open && (
            <div className="p-4 border-t border-border">
              <div className="text-xs text-muted-foreground">
                <p>بوت التداول الذكي v2.0</p>
                <p className="mt-1">تداول الأوبشنز</p>
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
