import { Sparkles, Settings, LogOut, LayoutDashboard } from "lucide-react";
import { ReactNode } from "react";
import { useLocation, Link } from "wouter";
import { useAuth } from "@/hooks/auth/useAuth";
import { Button } from "@/components/ui/button";

interface HeaderProps {
  children?: ReactNode;
}

export default function Header({ children }: HeaderProps) {
  const { user, logout, isAuthenticated } = useAuth();
  const [location, setLocation] = useLocation();

  return (
    <header 
      className="sticky top-0 z-50 h-16 border-b border-border/40 bg-background/80 backdrop-blur-md flex items-center justify-between px-4 sm:px-6 transition-all duration-200 ease-in-out shadow-sm"
      role="banner"
      aria-label="Main navigation"
    >
      <Link href="/">
        <div className="flex items-center gap-3 cursor-pointer group">
          <div 
            className="w-9 h-9 bg-gradient-primary rounded-lg flex items-center justify-center shadow-primary/20 transition-transform duration-200 ease-in-out group-hover:scale-105"
            aria-hidden="true"
          >
            <Sparkles className="w-5 h-5 text-primary-foreground" aria-hidden="true" />
          </div>
          <h1 className="text-lg sm:text-xl font-semibold tracking-tight text-foreground">
            AI-Driven DevOps
          </h1>
        </div>
      </Link>

      <div className="flex items-center gap-2">
        {children}
        
        {isAuthenticated && (
          <>
            <div className="h-6 w-px bg-border/50 mx-2 hidden sm:block" />
            
            <div className="hidden md:flex flex-col items-end mr-2">
              <span className="text-xs font-medium text-foreground">{user?.username}</span>
              <span className="text-[10px] text-muted-foreground leading-none">{user?.email}</span>
            </div>

            <Button
              variant="ghost"
              size="icon"
              onClick={() => setLocation('/')}
              className={location === '/' ? "text-primary" : "text-muted-foreground"}
              title="Dashboard"
            >
              <LayoutDashboard className="w-5 h-5" />
            </Button>

            <Button
              variant="ghost"
              size="icon"
              onClick={() => setLocation('/settings')}
              className={location === '/settings' ? "text-primary" : "text-muted-foreground"}
              title="Settings"
            >
              <Settings className="w-5 h-5" />
            </Button>

            <Button
              variant="ghost"
              size="icon"
              onClick={() => logout()}
              className="text-muted-foreground hover:text-destructive"
              title="Logout"
            >
              <LogOut className="w-5 h-5" />
            </Button>
          </>
        )}
      </div>
    </header>
  );
}
