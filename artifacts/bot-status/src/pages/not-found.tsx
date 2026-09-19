import { Link } from "wouter";
import { TerminalSquare, ArrowLeft } from "lucide-react";

export default function NotFound() {
  return (
    <div className="w-full h-[60vh] flex flex-col items-center justify-center text-foreground font-sans selection:bg-primary/20">
      <div className="flex flex-col items-center gap-6 max-w-md text-center">
        <div className="p-4 bg-secondary text-muted-foreground border border-border rounded-sm">
          <TerminalSquare className="w-12 h-12" />
        </div>
        <div className="space-y-2">
          <h1 className="text-4xl font-bold tracking-tight">404</h1>
          <p className="text-muted-foreground font-mono text-sm">
            TERMINAL PATH NOT RECOGNIZED
          </p>
        </div>
        <p className="text-muted-foreground text-sm max-w-[280px]">
          The requested operational matrix surface could not be located on this server.
        </p>
        <Link href="/" className="mt-4 flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground font-mono font-bold text-xs uppercase tracking-wider hover:bg-primary/90 transition-colors border border-primary rounded-sm" data-testid="link-not-found-home">
          <ArrowLeft className="w-4 h-4" />
          RETURN TO MAIN SYSCOM
        </Link>
      </div>
    </div>
  );
}
