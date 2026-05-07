class Agentmux < Formula
  desc "Quota-aware local OpenAI-compatible LLM gateway for coding agents"
  homepage "https://github.com/ryusei-mogi/AgentMux"
  url "https://github.com/ryusei-mogi/AgentMux/releases/download/v0.4.0/ryusei-mogi-agentmux-0.4.0.tgz"
  sha256 "b4b4322c40948f884ca29bad2f72b9cded29957e5bbbc00a498d17850884a7ca"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args(prefix: libexec, ignore_scripts: false)
    bin.install_symlink libexec/"bin/agentmux"
  end

  test do
    assert_match "0.4.0", shell_output("#{bin}/agentmux --version")
  end
end
