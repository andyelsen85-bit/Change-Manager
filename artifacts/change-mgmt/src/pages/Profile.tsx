import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth-context";

export function ProfilePage() {
  const { user, refresh } = useAuth();
  const [fullName, setFullName] = useState(user?.fullName ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const saveProfile = useMutation({
    mutationFn: () => api.patch(`/users/me`, { fullName, email }),
    onSuccess: async () => {
      toast.success("Profile updated");
      await refresh();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Update failed"),
  });

  const changePassword = useMutation({
    mutationFn: () => api.post("/auth/change-password", { currentPassword, newPassword }),
    onSuccess: async () => {
      toast.success("Password changed");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      // Refresh the session so `mustChangePassword` flips to false and the
      // user is unblocked from the rest of the app.
      await refresh();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Password change failed"),
  });

  if (!user) return null;

  return (
    <div className="mx-auto max-w-3xl space-y-4" data-testid="page-profile">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">My profile</h2>
        <p className="text-sm text-muted-foreground">Manage your personal information and password.</p>
      </div>

      {user.mustChangePassword && (
        <Alert variant="destructive" data-testid="alert-must-change-password">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Password change required</AlertTitle>
          <AlertDescription>
            You are using the default or initial credential. Please choose a new password before continuing.
            The rest of the app is locked until you rotate it.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Account</CardTitle>
          <CardDescription>Username: <span className="font-mono">{user.username}</span> · Source: {user.source}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Full name</Label>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} data-testid="input-profile-name" />
          </div>
          <div className="space-y-2">
            <Label>Email</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="input-profile-email" />
          </div>
          <div className="flex justify-end">
            <Button onClick={() => saveProfile.mutate()} disabled={saveProfile.isPending} data-testid="button-save-profile">
              {saveProfile.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              <Save className="mr-2 h-4 w-4" /> Save profile
            </Button>
          </div>
        </CardContent>
      </Card>

      {user.source === "local" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Change password</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Current password</Label>
              <Input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} data-testid="input-current-password" />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <Label>New password</Label>
                <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} data-testid="input-new-password" />
              </div>
              <div className="space-y-2">
                <Label>Confirm new password</Label>
                <Input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} data-testid="input-confirm-password" />
              </div>
            </div>
            <div className="flex justify-end">
              <Button
                onClick={() => {
                  if (newPassword.length < 8) {
                    toast.error("New password must be at least 8 characters");
                    return;
                  }
                  if (newPassword !== confirmPassword) {
                    toast.error("Passwords do not match");
                    return;
                  }
                  changePassword.mutate();
                }}
                disabled={changePassword.isPending || !currentPassword || !newPassword}
                data-testid="button-change-password"
              >
                {changePassword.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Change password
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
