class Agentmux < Formula
  desc "Quota-aware local OpenAI-compatible LLM gateway for coding agents"
  homepage "https://github.com/ryusei-mogi/AgentMux"
  url "https://registry.npmjs.org/agentmux/-/agentmux-0.3.0.tgz"
  sha256 "REPLACE_WITH_RELEASE_TARBALL_SHA256"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *Language::Node.std_npm_install_args(libexec)
    bin.install_symlink libexec/"bin/agentmux"
  end

  test do
    assert_match "0.3.0", shell_output("#{bin}/agentmux --version")
  end
end
