class Agentmux < Formula
  desc "Quota-aware local OpenAI-compatible LLM gateway for coding agents"
  homepage "https://github.com/ryusei-mogi/AgentMux"
  url "https://github.com/ryusei-mogi/AgentMux/releases/download/v0.5.0/ryusei-mogi-agentmux-0.5.0.tgz"
  sha256 "0d87d8c8742000c67828f84163ab2542aa6c21cc0496f8843aab1c23f0813a3a"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args(prefix: libexec, ignore_scripts: false)
    bin.install_symlink libexec/"bin/agentmux"
  end

  test do
    assert_match "0.5.0", shell_output("#{bin}/agentmux --version")
  end
end
